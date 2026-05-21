use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use thiserror::Error;

#[derive(Debug, Deserialize, Serialize, Clone)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct ChatRequest {
    base_url: String,
    api_key: String,
    model: String,
    system_prompt: String,
    messages: Vec<ChatMessage>,
}

#[derive(Debug, Serialize)]
struct OpenAiRequest {
    model: String,
    messages: Vec<ChatMessage>,
    temperature: f32,
}

#[derive(Debug, Deserialize)]
struct OpenAiResponse {
    choices: Vec<OpenAiChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChoice {
    message: ChatMessage,
}

#[derive(Debug, Serialize)]
struct MmdAsset {
    path: String,
    file_name: String,
}

#[derive(Debug, Serialize)]
struct CursorPosition {
    x: f64,
    y: f64,
}

#[derive(Debug, Error)]
enum AppError {
    #[error("Base URL、API Key 和 Model 都不能为空")]
    MissingConfig,
    #[error("请求失败：{0}")]
    Request(#[from] reqwest::Error),
    #[error("接口没有返回内容")]
    EmptyResponse,
    #[error("窗口操作失败：{0}")]
    Window(String),
    #[error("配置文件错误：{0}")]
    Config(String),
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Config(error.to_string()))?;
    fs::create_dir_all(&dir).map_err(|error| AppError::Config(error.to_string()))?;
    Ok(dir.join("config.json"))
}

fn sanitize_file_name(file_name: &str) -> String {
    file_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

fn decode_data_url(data_url: &str) -> Result<Vec<u8>, AppError> {
    let encoded = data_url
        .split_once(',')
        .map(|(_, value)| value)
        .ok_or_else(|| AppError::Config("模型数据格式错误".into()))?;
    general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| AppError::Config(error.to_string()))
}

#[tauri::command]
async fn load_config(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, AppError> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(path).map_err(|error| AppError::Config(error.to_string()))?;
    let value = serde_json::from_str(&raw).map_err(|error| AppError::Config(error.to_string()))?;
    Ok(Some(value))
}

#[tauri::command]
async fn save_config(app: tauri::AppHandle, config: serde_json::Value) -> Result<(), AppError> {
    let path = config_path(&app)?;
    let raw = serde_json::to_string_pretty(&config).map_err(|error| AppError::Config(error.to_string()))?;
    fs::write(path, raw).map_err(|error| AppError::Config(error.to_string()))?;
    Ok(())
}

#[tauri::command]
async fn save_mmd_asset(app: tauri::AppHandle, file_name: String, data_url: String) -> Result<MmdAsset, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Config(error.to_string()))?
        .join("mmd");
    fs::create_dir_all(&dir).map_err(|error| AppError::Config(error.to_string()))?;

    let safe_name = sanitize_file_name(&file_name);
    let safe_name = if safe_name.is_empty() { "model.zip".into() } else { safe_name };
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| AppError::Config(error.to_string()))?
        .as_millis();
    let path = dir.join(format!("{timestamp}-{safe_name}"));
    fs::write(&path, decode_data_url(&data_url)?).map_err(|error| AppError::Config(error.to_string()))?;

    Ok(MmdAsset {
        path: path.to_string_lossy().to_string(),
        file_name,
    })
}

#[tauri::command]
async fn read_mmd_asset(path: String) -> Result<String, AppError> {
    let bytes = fs::read(path).map_err(|error| AppError::Config(error.to_string()))?;
    Ok(format!(
        "data:application/octet-stream;base64,{}",
        general_purpose::STANDARD.encode(bytes)
    ))
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn CGEventCreate(source: *const std::ffi::c_void) -> *mut std::ffi::c_void;
    fn CGEventGetLocation(event: *mut std::ffi::c_void) -> CGPoint;
    fn CFRelease(cf: *const std::ffi::c_void);
}

#[tauri::command]
async fn cursor_position() -> Result<Option<CursorPosition>, AppError> {
    #[cfg(target_os = "macos")]
    {
        unsafe {
            let event = CGEventCreate(std::ptr::null());
            if event.is_null() {
                return Ok(None);
            }
            let point = CGEventGetLocation(event);
            CFRelease(event);
            return Ok(Some(CursorPosition { x: point.x, y: point.y }));
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}

#[tauri::command]
async fn show_settings(app: tauri::AppHandle) -> Result<(), AppError> {
    let window = app
        .get_webview_window("settings")
        .ok_or_else(|| AppError::Window("找不到设置窗口".into()))?;

    window.show().map_err(|error| AppError::Window(error.to_string()))?;
    window.set_focus().map_err(|error| AppError::Window(error.to_string()))?;
    Ok(())
}

#[tauri::command]
async fn show_pet(app: tauri::AppHandle) -> Result<(), AppError> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::Window("找不到桌宠窗口".into()))?;

    window.show().map_err(|error| AppError::Window(error.to_string()))?;
    window.set_always_on_top(true).map_err(|error| AppError::Window(error.to_string()))?;
    window.center().map_err(|error| AppError::Window(error.to_string()))?;
    window.set_focus().map_err(|error| AppError::Window(error.to_string()))?;
    Ok(())
}

#[tauri::command]
async fn recover_pet_window(app: tauri::AppHandle, width: f64, height: f64) -> Result<(), AppError> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::Window("找不到桌宠窗口".into()))?;

    window.show().map_err(|error| AppError::Window(error.to_string()))?;
    window.set_always_on_top(true).map_err(|error| AppError::Window(error.to_string()))?;
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| AppError::Window(error.to_string()))?;
    window.center().map_err(|error| AppError::Window(error.to_string()))?;
    window.set_focus().map_err(|error| AppError::Window(error.to_string()))?;
    Ok(())
}

#[tauri::command]
async fn align_pet_to_top(app: tauri::AppHandle, width: f64, height: f64) -> Result<(), AppError> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::Window("找不到桌宠窗口".into()))?;

    window.show().map_err(|error| AppError::Window(error.to_string()))?;
    window.set_always_on_top(true).map_err(|error| AppError::Window(error.to_string()))?;
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| AppError::Window(error.to_string()))?;

    let monitor = window
        .current_monitor()
        .map_err(|error| AppError::Window(error.to_string()))?
        .ok_or_else(|| AppError::Window("找不到当前屏幕".into()))?;
    let current_position = window
        .outer_position()
        .map_err(|error| AppError::Window(error.to_string()))?;
    let target_width = (width * monitor.scale_factor()).round() as i32;

    let monitor_left = monitor.position().x;
    let monitor_top = monitor.position().y;
    let monitor_right = monitor_left + monitor.size().width as i32;
    let max_x = (monitor_right - target_width).max(monitor_left);
    let next_x = current_position.x.clamp(monitor_left, max_x);

    window
        .set_position(PhysicalPosition::new(next_x, monitor_top))
        .map_err(|error| AppError::Window(error.to_string()))?;
    window.set_focus().map_err(|error| AppError::Window(error.to_string()))?;
    Ok(())
}

#[tauri::command]
async fn open_new_instance() -> Result<(), AppError> {
    let executable = std::env::current_exe().map_err(|error| AppError::Window(error.to_string()))?;
    Command::new(executable)
        .spawn()
        .map_err(|error| AppError::Window(error.to_string()))?;
    Ok(())
}

#[tauri::command]
async fn quit_app(app: tauri::AppHandle) -> Result<(), AppError> {
    app.exit(0);
    Ok(())
}

#[tauri::command]
async fn chat_completion(request: ChatRequest) -> Result<String, AppError> {
    let base_url = request.base_url.trim().trim_end_matches('/');
    let api_key = request.api_key.trim();
    let model = request.model.trim();

    if base_url.is_empty() || api_key.is_empty() || model.is_empty() {
        return Err(AppError::MissingConfig);
    }

    let mut messages = vec![ChatMessage {
        role: "system".into(),
        content: request.system_prompt,
    }];
    messages.extend(request.messages);

    let payload = OpenAiRequest {
        model: model.into(),
        messages,
        temperature: 0.7,
    };

    let response = reqwest::Client::new()
        .post(format!("{base_url}/chat/completions"))
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await?
        .error_for_status()?
        .json::<OpenAiResponse>()
        .await?;

    response
        .choices
        .into_iter()
        .next()
        .map(|choice| choice.message.content)
        .filter(|content| !content.trim().is_empty())
        .ok_or(AppError::EmptyResponse)
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.show()?;
                window.set_always_on_top(true)?;
                window.center()?;
                window.set_focus()?;
            }

            WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html?view=settings".into()))
                .title("Desk Buddy 设置")
                .inner_size(780.0, 720.0)
                .min_inner_size(620.0, 560.0)
                .resizable(true)
                .visible(false)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            save_mmd_asset,
            read_mmd_asset,
            cursor_position,
            show_settings,
            show_pet,
            recover_pet_window,
            align_pet_to_top,
            open_new_instance,
            quit_app,
            chat_completion
        ])
        .run(tauri::generate_context!())
        .expect("error while running desk pet");
}
