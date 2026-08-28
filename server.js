const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcrypt");

const CONFIG_FILE = "./config.json";
const USERS_FILE = "./users.json";
const REQUESTS_FILE = "./requests.json";

// メモリ上のログインセッション
const sessions = new Map();

function loadJSON(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveJSON(file, data) {
    fs.writeFileSync(
        file,
        JSON.stringify(data, null, 2),
        "utf8"
    );
}

function sendJSON(res, statusCode, data) {
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8"
    });

    res.end(JSON.stringify(data));
}

function getRequestBody(req, callback) {
    let body = "";

    req.on("data", chunk => {
        body += chunk;
    });

    req.on("end", () => {
        try {
            callback(null, JSON.parse(body));
        } catch {
            callback(new Error("JSONの形式が正しくありません"));
        }
    });
}

function hasPendingRequest(requests, userId) {
    return Object.values(requests.requests).some(request =>
        request.userId === userId &&
        request.status === "pending"
    );
}

function createRequestId(requests) {
    let number = Object.keys(requests.requests).length + 1;
    let id = `request${String(number).padStart(4, "0")}`;

    while (requests.requests[id]) {
        number++;
        id = `request${String(number).padStart(4, "0")}`;
    }

    return id;
}

// =========================
// ログインユーザーを取得
// =========================

function getSessionUser(req) {

    const authorization = req.headers.authorization;

    if (!authorization) {
        return null;
    }

    if (!authorization.startsWith("Bearer ")) {
        return null;
    }

    const token = authorization.substring(7);

    return sessions.get(token) || null;
}

function getAdminSessionUser(req) {

    const userId = getSessionUser(req);

    if (!userId) {
        return null;
    }

    const users = loadJSON(USERS_FILE);
    const user = users.users[userId];

    if (!user || user.role !== "admin") {
        return null;
    }

    return userId;
}

// =========================
// 金利処理
// =========================

function applyInterest(user) {

    if (!user.interest) {
        return;
    }

    if (!user.interest.startDate) {
        return;
    }

    const now = new Date();

    if (!user.interest.lastAppliedDate) {
        user.interest.lastAppliedDate =
            user.interest.startDate;
    }

    while (true) {

        const lastDate =
            new Date(user.interest.lastAppliedDate);

        const nextDate =
            new Date(lastDate);

        nextDate.setDate(
            nextDate.getDate() +
            user.interest.intervalDays
        );

        if (now < nextDate) {
            break;
        }

        const interest =
            Math.floor(
                user.interest.minimumBalance *
                user.interest.rate
            );

        user.savings += interest;

        user.interest.lastAppliedDate =
            nextDate.toISOString();

        user.interest.minimumBalance =
            user.savings;

        // 次の期間から最新設定を適用
        const config = loadJSON(CONFIG_FILE);

        user.interest.rate =
            config.interestRate;

        user.interest.intervalDays =
            config.interestIntervalDays;
    }
}

// =========================
// 金利設定変更
// =========================

function updateInterestConfig(rate, intervalDays) {

    const config = loadJSON(CONFIG_FILE);

    config.interestRate = rate;
    config.interestIntervalDays = intervalDays;

    saveJSON(CONFIG_FILE, config);
}

const server = http.createServer((req, res) => {

    // =========================
    // 新規登録
    // =========================

    if (
        req.method === "POST" &&
        req.url === "/api/register"
    ) {

        getRequestBody(req, async (error, data) => {

            if (error) {
                sendJSON(res, 400, {
                    error: error.message
                });
                return;
            }

            const { id, password } = data;

            if (
                typeof id !== "string" ||
                typeof password !== "string"
            ) {
                sendJSON(res, 400, {
                    error: "ユーザーIDとパスワードが必要です"
                });
                return;
            }

            if (id.length < 3 || id.length > 30) {
                sendJSON(res, 400, {
                    error: "ユーザーIDは3～30文字にしてください"
                });
                return;
            }

            if (password.length < 8 || password.length > 100) {
                sendJSON(res, 400, {
                    error: "パスワードは8～100文字にしてください"
                });
                return;
            }

            const users = loadJSON(USERS_FILE);

            if (users.users[id]) {
                sendJSON(res, 409, {
                    error: "そのユーザーIDは既に使用されています"
                });
                return;
            }

            const passwordHash = await bcrypt.hash(password, 12);

            users.users[id] = {
    passwordHash: passwordHash,
    role: "user",
    savings: 0,
    fixedDeposit: 0
};

            saveJSON(USERS_FILE, users);

            sendJSON(res, 201, {
                message: "アカウントを作成しました",
                id: id
            });
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

        getRequestBody(req, async (error, data) => {

            if (error) {
                sendJSON(res, 400, {
                    error: error.message
                });
                return;
            }

            const { id, password } = data;

            if (
                typeof id !== "string" ||
                typeof password !== "string"
            ) {
                sendJSON(res, 400, {
                    error: "ユーザーIDとパスワードが必要です"
                });
                return;
            }

            const users = loadJSON(USERS_FILE);
            const user = users.users[id];

            if (!user || !user.passwordHash) {
                sendJSON(res, 401, {
                    error: "ユーザーIDまたはパスワードが正しくありません"
                });
                return;
            }

            const passwordOK =
                await bcrypt.compare(password, user.passwordHash);

            if (!passwordOK) {
                sendJSON(res, 401, {
                    error: "ユーザーIDまたはパスワードが正しくありません"
                });
                return;
            }

            const token = crypto.randomBytes(32).toString("hex");

            sessions.set(token, id);

            sendJSON(res, 200, {
                message: "ログインしました",
                token: token
            });
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

    getRequestBody(req, async (error, data) => {

        if (error) {
            sendJSON(res, 400, {
                error: error.message
            });
            return;
        }

        const { id, password } = data;

        if (
            typeof id !== "string" ||
            typeof password !== "string"
        ) {
            sendJSON(res, 400, {
                error: "管理者IDとパスワードが必要です"
            });
            return;
        }

        const users = loadJSON(USERS_FILE);
        const user = users.users[id];

        if (!user || user.role !== "admin" || !user.passwordHash) {
            sendJSON(res, 401, {
                error: "管理者IDまたはパスワードが正しくありません"
            });
            return;
        }

        const passwordOK =
            await bcrypt.compare(password, user.passwordHash);

        if (!passwordOK) {
            sendJSON(res, 401, {
                error: "管理者IDまたはパスワードが正しくありません"
            });
            return;
        }

        const token =
            crypto.randomBytes(32).toString("hex");

        sessions.set(token, id);

        sendJSON(res, 200, {
            message: "管理者ログインしました",
            token: token
        });
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

        const userId = getSessionUser(req);

        if (!userId) {
            sendJSON(res, 401, {
                error: "ログインが必要です"
            });
            return;
        }

        const users = loadJSON(USERS_FILE);
const user = users.users[userId];

applyInterest(user);

saveJSON(USERS_FILE, users);

sendJSON(res, 200, {
    id: userId,
    savings: user.savings,
    fixedDeposit: user.fixedDeposit
});

        return;
    }

    // =========================
    // 入出金申請
    // =========================

    if (
        req.method === "POST" &&
        (req.url === "/api/deposit" ||
         req.url === "/api/withdraw")
    ) {

        const userId = getSessionUser(req);

        if (!userId) {
            sendJSON(res, 401, {
                error: "ログインが必要です"
            });
            return;
        }

        getRequestBody(req, (error, data) => {

            if (error) {
                sendJSON(res, 400, {
                    error: error.message
                });
                return;
            }

            const { amount } = data;

            if (
                typeof amount !== "number" ||
                !Number.isInteger(amount) ||
                amount <= 0
            ) {
                sendJSON(res, 400, {
                    error: "正の整数の金額が必要です"
                });
                return;
            }

            const users = loadJSON(USERS_FILE);
            const requests = loadJSON(REQUESTS_FILE);

            const user = users.users[userId];

            if (!user) {
                sendJSON(res, 404, {
                    error: "ユーザーが存在しません"
                });
                return;
            }

            if (hasPendingRequest(requests, userId)) {
                sendJSON(res, 409, {
                    error: "現在、承認待ちの申請があります"
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
                    error: "普通預金残高が不足しています"
                });
                return;
            }

            const requestId = createRequestId(requests);

            requests.requests[requestId] = {
                userId: userId,
                type: type,
                amount: amount,
                status: "pending",
                createdAt: new Date().toISOString()
            };

            saveJSON(REQUESTS_FILE, requests);

            sendJSON(res, 201, {
                message:
                    type === "deposit"
                        ? "預金申請を受け付けました"
                        : "出金申請を受け付けました",

                requestId: requestId,
                status: "pending"
            });
        });

        return;
    }


// =========================
// 管理者：金利設定変更
// =========================

if (
    req.method === "POST" &&
    req.url === "/api/admin/interest-config"
) {

    const adminId = getAdminSessionUser(req);

    if (!adminId) {
        sendJSON(res, 403, {
            error: "管理者権限が必要です"
        });
        return;
    }

    getRequestBody(req, (error, data) => {

        if (error) {
            sendJSON(res, 400, {
                error: error.message
            });
            return;
        }

        const {
            interestRate,
            interestIntervalDays
        } = data;

        if (
            typeof interestRate !== "number" ||
            interestRate < 0
        ) {
            sendJSON(res, 400, {
                error: "金利が正しくありません"
            });
            return;
        }

        if (
            typeof interestIntervalDays !== "number" ||
            !Number.isInteger(interestIntervalDays) ||
            interestIntervalDays <= 0
        ) {
            sendJSON(res, 400, {
                error: "付与間隔が正しくありません"
            });
            return;
        }

        const config = loadJSON(CONFIG_FILE);

        config.interestRate = interestRate;
        config.interestIntervalDays =
            interestIntervalDays;

        saveJSON(CONFIG_FILE, config);

        sendJSON(res, 200, {
            message: "金利設定を変更しました",
            interestRate:
                config.interestRate,
            interestIntervalDays:
                config.interestIntervalDays
        });
    });

    return;
}

// =========================
// 管理者：現在の金利設定取得
// =========================

if (
    req.method === "GET" &&
    req.url === "/api/admin/interest-config"
) {

    const adminId = getAdminSessionUser(req);

    if (!adminId) {
        sendJSON(res, 403, {
            error: "管理者権限が必要です"
        });
        return;
    }

    const config = loadJSON(CONFIG_FILE);

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
    req.url === "/api/admin/requests"
) {

    const adminId = getAdminSessionUser(req);

    if (!adminId) {
        sendJSON(res, 403, {
            error: "管理者権限が必要です"
        });
        return;
    }

    const requests = loadJSON(REQUESTS_FILE);
        sendJSON(res, 200, requests);

        return;
    }

// =========================
// 自分の申請一覧
// =========================

if (
    req.method === "GET" &&
    req.url === "/api/my-requests"
) {

    const userId = getSessionUser(req);

    if (!userId) {
        sendJSON(res, 401, {
            error: "ログインが必要です"
        });
        return;
    }

    const requests = loadJSON(REQUESTS_FILE);

    const myRequests = Object.entries(requests.requests)
        .filter(([requestId, request]) =>
            request.userId === userId
        )
        .map(([requestId, request]) => ({
            requestId: requestId,
            type: request.type,
            amount: request.amount,
            status: request.status,
            createdAt: request.createdAt,
            processedAt: request.processedAt || null
        }));

    sendJSON(res, 200, {
        requests: myRequests
    });

    return;
}

    // =========================
    // 管理者：承認・却下
    // =========================

    if (
        req.method === "POST" &&
        req.url === "/api/admin/request"
    ) {
const adminId = getAdminSessionUser(req);

if (!adminId) {
    sendJSON(res, 403, {
        error: "管理者権限が必要です"
    });
    return;
}

        getRequestBody(req, (error, data) => {

            if (error) {
                sendJSON(res, 400, {
                    error: error.message
                });
                return;
            }

            const { requestId, action } = data;

            if (
                !requestId ||
                (action !== "approve" && action !== "reject")
            ) {
                sendJSON(res, 400, {
                    error: "requestIdとactionが必要です"
                });
                return;
            }

            const users = loadJSON(USERS_FILE);
            const requests = loadJSON(REQUESTS_FILE);

            const request = requests.requests[requestId];

            if (!request) {
                sendJSON(res, 404, {
                    error: "申請が存在しません"
                });
                return;
            }

            if (request.status !== "pending") {
                sendJSON(res, 409, {
                    error: "この申請はすでに処理されています"
                });
                return;
            }

            const user = users.users[request.userId];

            if (!user) {
                sendJSON(res, 404, {
                    error: "申請対象のユーザーが存在しません"
                });
                return;
            }

            if (action === "reject") {

                request.status = "rejected";
                request.processedAt = new Date().toISOString();

                saveJSON(REQUESTS_FILE, requests);

                sendJSON(res, 200, {
                    message: "申請を却下しました",
                    requestId: requestId,
                    status: "rejected"
                });

                return;
            }

            if (request.type === "deposit") {

    const wasZero = user.savings === 0;

    user.savings += request.amount;

    if (wasZero && user.savings > 0) {

        if (!user.interest) {
            user.interest = {
                startDate: null,
                lastAppliedDate: null,
                minimumBalance: user.savings,
                rate: 0.1,
                intervalDays: 30
            };
        }

        if (!user.interest.startDate) {
            user.interest.startDate = new Date().toISOString();
            user.interest.lastAppliedDate = null;
            user.interest.minimumBalance = user.savings;
        }
    }


            } else if (request.type === "withdraw") {

                if (user.savings < request.amount) {
                    sendJSON(res, 400, {
                        error: "承認時点で残高が不足しています"
                    });
                    return;
                }

                user.savings -= request.amount;
            }

// =========================
// 金利期間中の最低残高を更新
// =========================

if (
    user.interest &&
    user.interest.startDate &&
    user.savings < user.interest.minimumBalance
) {
    user.interest.minimumBalance =
        user.savings;
}

            request.status = "approved";
            request.processedAt = new Date().toISOString();

            saveJSON(USERS_FILE, users);
            saveJSON(REQUESTS_FILE, requests);

            sendJSON(res, 200, {
                message: "申請を承認しました",
                requestId: requestId,
                status: "approved",
                savings: user.savings
            });
        });

        return;
    }

    // =========================
    // ユーザー一覧
    // =========================

    if (
        req.method === "GET" &&
        req.url === "/api/users"
    ) {

        const users = loadJSON(USERS_FILE);

        sendJSON(res, 200, users);

        return;
    }


// =========================
// Web画面
// =========================

if (req.method === "GET") {

    let filePath;

    if (req.url === "/") {
        filePath = path.join(__dirname, "public", "index.html");
    } else {
        filePath = path.join(__dirname, "public", req.url);
    }

    if (fs.existsSync(filePath)) {

        const ext = path.extname(filePath);

        let contentType = "text/plain";

        if (ext === ".html") {
            contentType = "text/html; charset=utf-8";
        } else if (ext === ".css") {
            contentType = "text/css; charset=utf-8";
        } else if (ext === ".js") {
            contentType = "application/javascript; charset=utf-8";
        }

        res.writeHead(200, {
            "Content-Type": contentType
        });

        res.end(fs.readFileSync(filePath));

        return;
    }
}

// =========================
// サーバー確認
// =========================

const config = loadJSON(CONFIG_FILE);

sendJSON(res, 200, {
    message: "SKYBANK SERVER OK",
    settings: config
});

});

server.listen(3000, () => {
    console.log(
        "SKYBANK server started: http://localhost:3000"
    );
});
