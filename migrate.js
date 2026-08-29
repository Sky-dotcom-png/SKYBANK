const fs = require("fs");
const { Pool } = require("pg");

const users = JSON.parse(
    fs.readFileSync("./users.json", "utf8")
);

const connectionString = process.argv[2];

if (!connectionString) {
    console.log("Postgresの接続URLを指定してください");
    process.exit(1);
}

const pool = new Pool({
    connectionString
    });

async function migrate() {
    try {
        for (const [id, user] of Object.entries(users.users)) {
            await pool.query(
                `
                INSERT INTO users
                    (id, password_hash, role, savings, fixed_deposit, interest)
                VALUES
                    ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (id)
                DO UPDATE SET
                    password_hash = EXCLUDED.password_hash,
                    role = EXCLUDED.role,
                    savings = EXCLUDED.savings,
                    fixed_deposit = EXCLUDED.fixed_deposit,
                    interest = EXCLUDED.interest
                `,
                [
                    id,
                    user.passwordHash || "",
                    user.role || "user",
                    user.savings || 0,
                    user.fixedDeposit || 0,
                    user.interest || null
                ]
            );

            console.log(`移行成功: ${id}`);
        }

        console.log("全ユーザーの移行が完了しました！");
    } catch (error) {
        console.error("移行失敗:");
        console.error(error);
    } finally {
        await pool.end();
    }
}

migrate();