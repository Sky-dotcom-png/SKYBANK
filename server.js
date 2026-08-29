const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { Pool } = require("pg");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
    });

const CONFIG_FILE = path.join(__dirname, "config.json");

// =========================
// セッション
// =========================

const sessions = new Map();

// =========================
// JSON設定ファイル
// config.jsonだけ使用
// =========================

function loadConfig() {
    return JSON.parse(
        fs.readFileSync(CONFIG_FILE, "utf8")
    );
}

function saveConfig(config) {
    fs.writeFileSync(
        CONFIG_FILE,
        JSON.stringify(config, null, 2),
        "utf8"
    );
}

// =========================
// JSONレスポンス
// =========================

function sendJSON(res, statusCode, data) {
    if (res.writableEnded) {
        return;
    }

    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8"
    });

    res.end(JSON.stringify(data));
}

// =========================
// リクエストBody
// =========================

function getRequestBody(req) {
    return new Promise((resolve, reject) => {

        let body = "";

        req.on("data", chunk => {
            body += chunk;

            // 異常に大きいリクエストを拒否
            if (body.length > 1024 * 1024) {
                reject(
                    new Error("リクエストが大きすぎます")
                );

                req.destroy();
            }
        });

        req.on("end", () => {

            if (!body) {
                resolve({});
                return;
            }

            try {
                resolve(JSON.parse(body));
            } catch {
                reject(
                    new Error("JSONの形式が正しくありません")
                );
            }
        });

        req.on("error", reject);
    });
}

// =========================
// PostgreSQL
// =========================

async function initDatabase() {

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            savings INTEGER NOT NULL DEFAULT 0,
            fixed_deposit INTEGER NOT NULL DEFAULT 0,
            interest JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    // 既存DBにも登録日を追加
    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
    `);

    await pool.query(`
        UPDATE users
        SET created_at = NOW()
        WHERE created_at IS NULL;
    `);

    await pool.query(`
        ALTER TABLE users
        ALTER COLUMN created_at SET DEFAULT NOW(),
        ALTER COLUMN created_at SET NOT NULL;
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS requests (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            type TEXT NOT NULL,
            amount INTEGER NOT NULL,
            status TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            processed_at TIMESTAMPTZ
        );
    `);

    console.log("PostgreSQL connected and tables ready");
}

// =========================
// ユーザー取得
// =========================

async function getUserFromDB(userId) {

    const result = await pool.query(
        `
        SELECT
            id,
            password_hash,
            role,
            savings,
            fixed_deposit,
            interest,
            created_at
        FROM users
        WHERE id = $1
        `,
        [userId]
    );

    if (result.rows.length === 0) {
        return null;
    }

    const row = result.rows[0];

    return {
        id: row.id,
        passwordHash: row.password_hash,
        role: row.role,
        savings: row.savings,
        fixedDeposit: row.fixed_deposit,
        interest: row.interest,
        createdAt: row.created_at
    };
}

// =========================
// セッションユーザー
// =========================

function getSessionUser(req) {

    const authorization =
        req.headers.authorization;

    if (!authorization) {
        return null;
    }

    if (!authorization.startsWith("Bearer ")) {
        return null;
    }

    const token =
        authorization.substring(7);

    return sessions.get(token) || null;
}

// =========================
// 管理者確認
// =========================

async function getAdminSessionUser(req) {

    const userId = getSessionUser(req);

    if (!userId) {
        return null;
    }

    const user = await getUserFromDB(userId);

    if (!user || user.role !== "admin") {
        return null;
    }

    return userId;
}

// =========================
// 金利処理
// =========================

async function applyInterest(user) {

    if (!user.interest) {
        return user;
    }

    if (!user.interest.startDate) {
        return user;
    }

    const now = new Date();

    if (!user.interest.lastAppliedDate) {
        user.interest.lastAppliedDate =
            user.interest.startDate;
    }

    const config = loadConfig();

    while (true) {

        const lastDate =
            new Date(
                user.interest.lastAppliedDate
            );

        const nextDate =
            new Date(lastDate);

        nextDate.setDate(
            nextDate.getDate() +
            user.interest.intervalDays
        );

        if (now < nextDate) {
            break;
        }

        const minimumBalance =
            Number(user.interest.minimumBalance || 0);

        const rate =
            Number(user.interest.rate || 0);

        const interest =
            Math.floor(
                minimumBalance * rate
            );

        user.savings += interest;

        user.interest.lastAppliedDate =
            nextDate.toISOString();

        user.interest.minimumBalance =
            user.savings;

        // 次の期間から現在の設定を使用
        user.interest.rate =
            Number(config.interestRate);

        user.interest.intervalDays =
            Number(config.interestIntervalDays);
    }

    // DBへ保存
    await pool.query(
        `
        UPDATE users
        SET
            savings = $1,
            interest = $2
        WHERE id = $3
        `,
        [
            user.savings,
            JSON.stringify(user.interest),
            user.id
        ]
    );

    return user;
}

// =========================
// 申請ID作成
// =========================

async function createRequestId() {

    const result = await pool.query(`
        SELECT id
        FROM requests
        ORDER BY id
    `);

    let number = result.rows.length + 1;

    let id =
        `request${String(number).padStart(4, "0")}`;

    const existingIds =
        new Set(result.rows.map(row => row.id));

    while (existingIds.has(id)) {

        number++;

        id =
            `request${String(number).padStart(4, "0")}`;
    }

    return id;
}

// =========================
// サーバー
// =========================

const server = http.createServer(
    async (req, res) => {

        try {

            // =========================
            // 新規登録
            // =========================

            if (
                req.method === "POST" &&
                req.url === "/api/register"
            ) {

                const data =
                    await getRequestBody(req);

                const { id, password } = data;

                if (
                    typeof id !== "string" ||
                    typeof password !== "string"
                ) {
                    sendJSON(res, 400, {
                        error:
                            "ユーザーIDとパスワードが必要です"
                    });
                    return;
                }

                if (
                    id.length < 3 ||
                    id.length > 30
                ) {
                    sendJSON(res, 400, {
                        error:
                            "ユーザーIDは3～30文字にしてください"
                    });
                    return;
                }

                if (
                    password.length < 8 ||
                    password.length > 100
                ) {
                    sendJSON(res, 400, {
                        error:
                            "パスワードは8～100文字にしてください"
                    });
                    return;
                }

                const existingUser =
                    await getUserFromDB(id);

                if (existingUser) {
                    sendJSON(res, 409, {
                        error:
                            "そのユーザーIDは既に使用されています"
                    });
                    return;
                }

                const passwordHash =
                    await bcrypt.hash(password, 12);

                await pool.query(
                    `
                    INSERT INTO users
                    (
                        id,
                        password_hash,
                        role,
                        savings,
                        fixed_deposit,
                        interest,
                        created_at
                    )
                    VALUES
                    ($1, $2, $3, $4, $5, $6, $7)
                    `,
                    [
                        id,
                        passwordHash,
                        "user",
                        0,
                        0,
                        null,
                        new Date()
                    ]
                );

                sendJSON(res, 201, {
                    message:
                        "アカウントを作成しました",
                    id: id
                });

                return;
            }

            // =========================
            // ログイン
            // =========================

            if (
                req.method === "POST" &&
                req.url === "/api/login"
            ) {

                const data =
                    await getRequestBody(req);

                const { id, password } = data;

                if (
                    typeof id !== "string" ||
                    typeof password !== "string"
                ) {
                    sendJSON(res, 400, {
                        error:
                            "ユーザーIDとパスワードが必要です"
                    });
                    return;
                }

                const user =
                    await getUserFromDB(id);

                if (
                    !user ||
                    !user.passwordHash
                ) {
                    sendJSON(res, 401, {
                        error:
                            "ユーザーIDまたはパスワードが正しくありません"
                    });
                    return;
                }

                const passwordOK =
                    await bcrypt.compare(
                        password,
                        user.passwordHash
                    );

                if (!passwordOK) {
                    sendJSON(res, 401, {
                        error:
                            "ユーザーIDまたはパスワードが正しくありません"
                    });
                    return;
                }

                const token =
                    crypto
                        .randomBytes(32)
                        .toString("hex");

                sessions.set(token, id);

                sendJSON(res, 200, {
                    message:
                        "ログインしました",
                    token: token
                });

                return;
            }

            // =========================
            // 管理者ログイン
            // =========================

            if (
                req.method === "POST" &&
                req.url === "/api/admin/login"
            ) {

                const data =
                    await getRequestBody(req);

                const { id, password } = data;

                if (
                    typeof id !== "string" ||
                    typeof password !== "string"
                ) {
                    sendJSON(res, 400, {
                        error:
                            "管理者IDとパスワードが必要です"
                    });
                    return;
                }

                const user =
                    await getUserFromDB(id);

                if (
                    !user ||
                    user.role !== "admin" ||
                    !user.passwordHash
                ) {
                    sendJSON(res, 401, {
                        error:
                            "管理者IDまたはパスワードが正しくありません"
                    });
                    return;
                }

                const passwordOK =
                    await bcrypt.compare(
                        password,
                        user.passwordHash
                    );

                if (!passwordOK) {
                    sendJSON(res, 401, {
                        error:
                            "管理者IDまたはパスワードが正しくありません"
                    });
                    return;
                }

                const token =
                    crypto
                        .randomBytes(32)
                        .toString("hex");

                sessions.set(token, id);

                sendJSON(res, 200, {
                    message:
                        "管理者ログインしました",
                    token: token
                });

                return;
            }

            // =========================
            // 自分の口座情報
            // =========================

            if (
                req.method === "GET" &&
                req.url === "/api/me"
            ) {

                const userId =
                    getSessionUser(req);

                if (!userId) {
                    sendJSON(res, 401, {
                        error:
                            "ログインが必要です"
                    });
                    return;
                }

                let user =
                    await getUserFromDB(userId);

                if (!user) {
                    sendJSON(res, 404, {
                        error:
                            "ユーザーが存在しません"
                    });
                    return;
                }

                user =
                    await applyInterest(user);

                sendJSON(res, 200, {
                    id: userId,
                    savings: user.savings,
                    fixedDeposit:
                        user.fixedDeposit
                });

                return;
            }

            // =========================
            // 入出金申請
            // =========================

            if (
                req.method === "POST" &&
                (
                    req.url === "/api/deposit" ||
                    req.url === "/api/withdraw"
                )
            ) {

                const userId =
                    getSessionUser(req);

                if (!userId) {
                    sendJSON(res, 401, {
                        error:
                            "ログインが必要です"
                    });
                    return;
                }

                const data =
                    await getRequestBody(req);

                const { amount } = data;

                if (
                    typeof amount !== "number" ||
                    !Number.isInteger(amount) ||
                    amount <= 0
                ) {
                    sendJSON(res, 400, {
                        error:
                            "正の整数の金額が必要です"
                    });
                    return;
                }

                const user =
                    await getUserFromDB(userId);

                if (!user) {
                    sendJSON(res, 404, {
                        error:
                            "ユーザーが存在しません"
                    });
                    return;
                }

                // 保留中の申請を確認
                const pending =
                    await pool.query(
                        `
                        SELECT id
                        FROM requests
                        WHERE user_id = $1
                        AND status = 'pending'
                        LIMIT 1
                        `,
                        [userId]
                    );

                if (pending.rows.length > 0) {
                    sendJSON(res, 409, {
                        error:
                            "現在、承認待ちの申請があります"
                    });
                    return;
                }

                const type =
                    req.url === "/api/deposit"
                        ? "deposit"
                        : "withdraw";

                if (
                    type === "withdraw" &&
                    user.savings < amount
                ) {
                    sendJSON(res, 400, {
                        error:
                            "普通預金残高が不足しています"
                    });
                    return;
                }

                const requestId =
                    await createRequestId();

                await pool.query(
                    `
                    INSERT INTO requests
                    (
                        id,
                        user_id,
                        type,
                        amount,
                        status,
                        created_at
                    )
                    VALUES
                    ($1, $2, $3, $4, $5, $6)
                    `,
                    [
                        requestId,
                        userId,
                        type,
                        amount,
                        "pending",
                        new Date()
                    ]
                );

                sendJSON(res, 201, {
                    message:
                        type === "deposit"
                            ? "預金申請を受け付けました"
                            : "出金申請を受け付けました",
                    requestId: requestId,
                    status: "pending"
                });

                return;
            }

            // =========================
            // 管理者：金利設定変更
            // =========================

            if (
                req.method === "POST" &&
                req.url ===
                    "/api/admin/interest-config"
            ) {

                const adminId =
                    await getAdminSessionUser(req);

                if (!adminId) {
                    sendJSON(res, 403, {
                        error:
                            "管理者権限が必要です"
                    });
                    return;
                }

                const data =
                    await getRequestBody(req);

                const {
                    interestRate,
                    interestIntervalDays
                } = data;

                if (
                    typeof interestRate !== "number" ||
                    interestRate < 0
                ) {
                    sendJSON(res, 400, {
                        error:
                            "金利が正しくありません"
                    });
                    return;
                }

                if (
                    typeof interestIntervalDays !==
                        "number" ||
                    !Number.isInteger(
                        interestIntervalDays
                    ) ||
                    interestIntervalDays <= 0
                ) {
                    sendJSON(res, 400, {
                        error:
                            "付与間隔が正しくありません"
                    });
                    return;
                }

                const config =
                    loadConfig();

                config.interestRate =
                    interestRate;

                config.interestIntervalDays =
                    interestIntervalDays;

                saveConfig(config);

                sendJSON(res, 200, {
                    message:
                        "金利設定を変更しました",
                    interestRate:
                        config.interestRate,
                    interestIntervalDays:
                        config.interestIntervalDays
                });

                return;
            }

            // =========================
            // 管理者：現在の金利設定
            // =========================

            if (
                req.method === "GET" &&
                req.url ===
                    "/api/admin/interest-config"
            ) {

                const adminId =
                    await getAdminSessionUser(req);

                if (!adminId) {
                    sendJSON(res, 403, {
                        error:
                            "管理者権限が必要です"
                    });
                    return;
                }

                const config =
                    loadConfig();

                sendJSON(res, 200, {
                    interestRate:
                        config.interestRate,
                    interestIntervalDays:
                        config.interestIntervalDays
                });

                return;
            }

            // =========================
            // 管理者：申請一覧
            // =========================

            if (
                req.method === "GET" &&
                req.url ===
                    "/api/admin/requests"
            ) {

                const adminId =
                    await getAdminSessionUser(req);

                if (!adminId) {
                    sendJSON(res, 403, {
                        error:
                            "管理者権限が必要です"
                    });
                    return;
                }

                const result =
                    await pool.query(`
                        SELECT
                            id,
                            user_id,
                            type,
                            amount,
                            status,
                            created_at,
                            processed_at
                        FROM requests
                        ORDER BY created_at DESC
                    `);

                const requests =
                    result.rows.map(row => ({
                        requestId: row.id,
                        userId: row.user_id,
                        type: row.type,
                        amount: row.amount,
                        status: row.status,
                        createdAt: row.created_at,
                        processedAt:
                            row.processed_at
                                || null
                    }));

                sendJSON(res, 200, {
                    requests: requests
                });

                return;
            }

            // =========================
            // 自分の申請一覧
            // =========================

            if (
                req.method === "GET" &&
                req.url ===
                    "/api/my-requests"
            ) {

                const userId =
                    getSessionUser(req);

                if (!userId) {
                    sendJSON(res, 401, {
                        error:
                            "ログインが必要です"
                    });
                    return;
                }

                const result =
                    await pool.query(
                        `
                        SELECT
                            id,
                            type,
                            amount,
                            status,
                            created_at,
                            processed_at
                        FROM requests
                        WHERE user_id = $1
                        ORDER BY created_at DESC
                        `,
                        [userId]
                    );

                const requests =
                    result.rows.map(row => ({
                        requestId: row.id,
                        type: row.type,
                        amount: row.amount,
                        status: row.status,
                        createdAt: row.created_at,
                        processedAt:
                            row.processed_at
                                || null
                    }));

                sendJSON(res, 200, {
                    requests: requests
                });

                return;
            }

            // =========================
            // 管理者：承認・却下
            // =========================

            if (
                req.method === "POST" &&
                req.url ===
                    "/api/admin/request"
            ) {

                const adminId =
                    await getAdminSessionUser(req);

                if (!adminId) {
                    sendJSON(res, 403, {
                        error:
                            "管理者権限が必要です"
                    });
                    return;
                }

                const data =
                    await getRequestBody(req);

                const {
                    requestId,
                    action
                } = data;

                if (
                    !requestId ||
                    (
                        action !== "approve" &&
                        action !== "reject"
                    )
                ) {
                    sendJSON(res, 400, {
                        error:
                            "requestIdとactionが必要です"
                    });
                    return;
                }

                const requestResult =
                    await pool.query(
                        `
                        SELECT *
                        FROM requests
                        WHERE id = $1
                        `,
                        [requestId]
                    );

                if (
                    requestResult.rows.length === 0
                ) {
                    sendJSON(res, 404, {
                        error:
                            "申請が存在しません"
                    });
                    return;
                }

                const request =
                    requestResult.rows[0];

                if (request.status !== "pending") {
                    sendJSON(res, 409, {
                        error:
                            "この申請はすでに処理されています"
                    });
                    return;
                }

                // =========================
                // 却下
                // =========================

                if (action === "reject") {

                    await pool.query(
                        `
                        UPDATE requests
                        SET
                            status = 'rejected',
                            processed_at = $1
                        WHERE id = $2
                        `,
                        [
                            new Date(),
                            requestId
                        ]
                    );

                    sendJSON(res, 200, {
                        message:
                            "申請を却下しました",
                        requestId:
                            requestId,
                        status:
                            "rejected"
                    });

                    return;
                }

                // =========================
                // 承認
                // =========================

                const user =
                    await getUserFromDB(
                        request.user_id
                    );

                if (!user) {
                    sendJSON(res, 404, {
                        error:
                            "申請対象のユーザーが存在しません"
                    });
                    return;
                }

                // 金利処理を先に実行
                const updatedUser =
                    await applyInterest(user);

                if (
                    request.type === "withdraw" &&
                    updatedUser.savings <
                        request.amount
                ) {
                    sendJSON(res, 400, {
                        error:
                            "承認時点で残高が不足しています"
                    });
                    return;
                }

                let newSavings =
                    updatedUser.savings;

                let interest =
                    updatedUser.interest;

                // =========================
                // 預金
                // =========================

                if (
                    request.type === "deposit"
                ) {

                    const wasZero =
                        newSavings === 0;

                    newSavings +=
                        request.amount;

                    if (
                        wasZero &&
                        newSavings > 0
                    ) {

                        if (!interest) {

                            interest = {
                                startDate: null,
                                lastAppliedDate: null,
                                minimumBalance:
                                    newSavings,
                                rate: Number(
                                    loadConfig()
                                        .interestRate
                                ),
                                intervalDays: Number(
                                    loadConfig()
                                        .interestIntervalDays
                                )
                            };
                        }

                        if (!interest.startDate) {

                            interest.startDate =
                                new Date()
                                    .toISOString();

                            interest.lastAppliedDate =
                                null;

                            interest.minimumBalance =
                                newSavings;
                        }
                    }
                }

                // =========================
                // 出金
                // =========================

                else if (
                    request.type === "withdraw"
                ) {

                    newSavings -=
                        request.amount;
                }

                // =========================
                // 金利期間中の最低残高
                // =========================

                if (
                    interest &&
                    interest.startDate &&
                    newSavings <
                        Number(
                            interest.minimumBalance
                        )
                ) {
                    interest.minimumBalance =
                        newSavings;
                }

                // =========================
                // DB更新
                // =========================

                await pool.query(
                    `
                    UPDATE users
                    SET
                        savings = $1,
                        interest = $2
                    WHERE id = $3
                    `,
                    [
                        newSavings,
                        interest
                            ? JSON.stringify(interest)
                            : null,
                        request.user_id
                    ]
                );

                await pool.query(
                    `
                    UPDATE requests
                    SET
                        status = 'approved',
                        processed_at = $1
                    WHERE id = $2
                    `,
                    [
                        new Date(),
                        requestId
                    ]
                );

                sendJSON(res, 200, {
                    message:
                        "申請を承認しました",
                    requestId:
                        requestId,
                    status:
                        "approved",
                    savings:
                        newSavings
                });

                return;
            }

            // =========================
            // 管理者：アカウント一覧
            // =========================

            if (
                req.method === "GET" &&
                req.url === "/api/admin/users"
            ) {

                const adminId =
                    await getAdminSessionUser(req);

                if (!adminId) {
                    sendJSON(res, 403, {
                        error:
                            "管理者権限が必要です"
                    });
                    return;
                }

                const result =
                    await pool.query(`
                        SELECT
                            id,
                            role,
                            savings,
                            fixed_deposit,
                            interest,
                            created_at
                        FROM users
                        ORDER BY created_at ASC, id ASC
                    `);

                const users = result.rows.map(row => {

                    const interest = row.interest;
                    let nextInterestDate = null;
                    let nextInterestAmount = null;

                    if (
                        interest &&
                        interest.startDate
                    ) {
                        const lastDate =
                            interest.lastAppliedDate ||
                            interest.startDate;

                        const intervalDays =
                            Number(interest.intervalDays || 0);

                        if (intervalDays > 0) {
                            const nextDate =
                                new Date(lastDate);

                            nextDate.setDate(
                                nextDate.getDate() +
                                intervalDays
                            );

                            nextInterestDate =
                                nextDate.toISOString();
                        }

                        nextInterestAmount =
                            Math.floor(
                                Number(interest.minimumBalance || 0) *
                                Number(interest.rate || 0)
                            );
                    }

                    return {
                        id: row.id,
                        role: row.role,
                        savings: row.savings,
                        fixedDeposit: row.fixed_deposit,
                        registrationDate: row.created_at,
                        nextInterestDate: nextInterestDate,
                        nextInterestAmount: nextInterestAmount
                    };
                });

                sendJSON(res, 200, {
                    users: users
                });

                return;
            }

            // =========================
            // Web画面
            // =========================

            if (req.method === "GET") {

                let filePath;

                if (req.url === "/") {

                    filePath =
                        path.join(
                            __dirname,
                            "public",
                            "index.html"
                        );

                } else {

                    // URLのクエリを除去
                    const pathname =
                        req.url.split("?")[0];

                    filePath =
                        path.join(
                            __dirname,
                            "public",
                            pathname
                        );
                }

                // public外へのアクセス防止
                const publicDir =
                    path.join(
                        __dirname,
                        "public"
                    );

                const resolvedPath =
                    path.resolve(filePath);

                if (
                    !resolvedPath.startsWith(
                        path.resolve(publicDir)
                    )
                ) {
                    sendJSON(res, 403, {
                        error:
                            "アクセスが拒否されました"
                    });
                    return;
                }

                if (
                    fs.existsSync(resolvedPath) &&
                    fs.statSync(resolvedPath).isFile()
                ) {

                    const ext =
                        path.extname(
                            resolvedPath
                        ).toLowerCase();

                    let contentType =
                        "text/plain; charset=utf-8";

                    if (ext === ".html") {
                        contentType =
                            "text/html; charset=utf-8";
                    } else if (ext === ".css") {
                        contentType =
                            "text/css; charset=utf-8";
                    } else if (ext === ".js") {
                        contentType =
                            "application/javascript; charset=utf-8";
                    }

                    res.writeHead(200, {
                        "Content-Type":
                            contentType
                    });

                    res.end(
                        fs.readFileSync(
                            resolvedPath
                        )
                    );

                    return;
                }
            }

            // =========================
            // サーバー確認
            // =========================

            sendJSON(res, 404, {
                error:
                    "ページまたはAPIが見つかりません"
            });

        } catch (error) {

            console.error(
                "Request error:",
                error
            );

            if (!res.writableEnded) {
                sendJSON(res, 500, {
                    error:
                        "サーバー内部エラー"
                });
            }
        }
    }
);

// =========================
// 起動
// =========================

async function startServer() {

    try {

        await initDatabase();

        const port =
            process.env.PORT || 3000;

        server.listen(
            port,
            () => {
                console.log(
                    `SKYBANK server started: http://localhost:${port}`
                );
            }
        );

    } catch (error) {

        console.error(
            "Server startup failed:",
            error
        );

        process.exit(1);
    }
}

startServer();