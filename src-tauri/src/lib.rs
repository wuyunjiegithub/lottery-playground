// 桌面端原生后端（Windows / macOS / Linux）
//
// 存在的唯一理由：官方开奖接口没有 CORS 头，浏览器里的 fetch 会被同源策略拦截。
// Rust 原生层发起的 HTTP 请求不经过浏览器，因此不受限制，且能自由设置 Referer
// ——而体彩接口恰恰必须带 Referer 才返回 JSON，否则返回风控页面。

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// 原生 HTTP GET。前端用 invoke('http_get', { url, referer }) 调用。
/// 响应体按 charset 自动解码（含 GBK），直接返回字符串。
#[tauri::command]
async fn http_get(url: String, referer: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent(UA)
        .build()
        .map_err(|e| format!("客户端创建失败: {}", e))?;

    let mut req = client
        .get(&url)
        .header("Accept", "application/json, text/plain, */*");
    if !referer.is_empty() {
        req = req.header("Referer", referer);
    }

    let resp = req.send().await.map_err(|e| format!("请求失败: {}", e))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;

    if !status.is_success() {
        return Err(format!("HTTP {}", status));
    }
    Ok(body)
}

/// 判断当前是否是 Tauri 环境，供前端探测
#[tauri::command]
fn tauri_ping() -> String {
    "pong".to_string()
}

// ---------------------------------------------------------------- 本地数据库
//
// 只放两类东西：
//   draws   开奖历史（不可再生，丢了要重新爬）
//   summary 回测汇总 + runs 批次元信息（约 1.5 MB，是「规律校验」主要的查询对象）
//
// 刻意不放的东西：回测逐期明细（约 20 万条 / 21.5 MB）。
// 那玩意儿改一次预算就得重算，属于完全可再生的派生产物，不值得占数据库。
//
// 注意：这里的 schema 必须与前端 src/adapters/storage/schema.ts 保持一致。

/// 数据库文件名。前端用 Database.load(SQLITE_URL) 打开同一个库
pub const SQLITE_URL: &str = "sqlite:lottery_playground.db";

fn migrations() -> Vec<tauri_plugin_sql::Migration> {
    use tauri_plugin_sql::{Migration, MigrationKind};
    vec![
        Migration {
            version: 1,
            description: "create draws",
            sql: r#"CREATE TABLE IF NOT EXISTS draws (
                lottery TEXT NOT NULL,
                issue   TEXT NOT NULL,
                date    TEXT,
                front   TEXT NOT NULL,
                back    TEXT NOT NULL,
                pool    TEXT,
                sales   TEXT,
                prizes  TEXT,
                source  TEXT,
                PRIMARY KEY (lottery, issue)
            )"#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "create runs",
            sql: r#"CREATE TABLE IF NOT EXISTS runs (
                run_key     TEXT PRIMARY KEY,
                lottery     TEXT NOT NULL,
                budget      INTEGER NOT NULL,
                prefer      TEXT NOT NULL,
                sample      INTEGER NOT NULL,
                periods     INTEGER NOT NULL,
                model_count INTEGER NOT NULL,
                created_at  INTEGER NOT NULL
            )"#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "create summary",
            sql: r#"CREATE TABLE IF NOT EXISTS summary (
                run_key     TEXT NOT NULL,
                model_id    TEXT NOT NULL,
                model_name  TEXT,
                category    TEXT,
                trials      INTEGER,
                total_cost  INTEGER,
                total_prize INTEGER,
                roi         REAL,
                win_rate    REAL,
                best_level  INTEGER,
                hits        TEXT,
                equity      TEXT,
                PRIMARY KEY (run_key, model_id)
            )"#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "create kv",
            sql: r#"CREATE TABLE IF NOT EXISTS kv (
                k TEXT PRIMARY KEY,
                v TEXT NOT NULL
            )"#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "create indexes",
            sql: r#"CREATE INDEX IF NOT EXISTS idx_draws_lottery ON draws(lottery, issue);
                    CREATE INDEX IF NOT EXISTS idx_summary_run ON summary(run_key, roi DESC)"#,
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(SQLITE_URL, migrations())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![http_get, tauri_ping])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败")
}
