const fs = require("fs");
const bcrypt = require("bcrypt");
const readline = require("readline");

const USERS_FILE = "./users.json";

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

rl.question("管理者ID: ", async (id) => {

    if (!id || id.length < 3) {
        console.log("管理者IDは3文字以上にしてください");
        rl.close();
        return;
    }

    rl.question("管理者パスワード: ", async (password) => {

        if (!password || password.length < 8) {
            console.log("パスワードは8文字以上にしてください");
            rl.close();
            return;
        }

        const users = JSON.parse(
            fs.readFileSync(USERS_FILE, "utf8")
        );

        if (users.users[id]) {
            console.log("そのユーザーIDは既に存在します");
            rl.close();
            return;
        }

        const passwordHash =
            await bcrypt.hash(password, 12);

        users.users[id] = {
            passwordHash: passwordHash,
            role: "admin",
            savings: 0,
            fixedDeposit: 0
        };

        fs.writeFileSync(
            USERS_FILE,
            JSON.stringify(users, null, 2),
            "utf8"
        );

        console.log("管理者アカウントを作成しました");

        rl.close();
    });
});