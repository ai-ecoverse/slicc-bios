use serde_json::{json, Value};

pub fn record(stage: &str, detail: Value) {
    eprintln!("SLICC_DIAGNOSTIC {}", json!({"stage":stage,"detail":detail}));
}

fn origin(value: &Value) -> Value {
    let Some(text) = value.as_str() else { return Value::Null };
    let Ok(url) = url::Url::parse(text) else { return json!(if text == "://" { "://" } else { "invalid" }) };
    if url.origin().ascii_serialization() == "null" {
        json!(format!("{}://{}", url.scheme(), url.host_str().unwrap_or("")))
    } else {
        json!(url.origin().ascii_serialization())
    }
}

pub fn error(text: &str) -> Value {
    let known = [
        "slicc: refused: seven’s own pages and the vault are out of reach of browser automation",
        "slicc: refused: target is on seven's origin",
        "slicc: refused: slicc can't keep seven's origin out of this target",
    ];
    json!(known.iter().find(|item| text.contains(**item)).copied().unwrap_or(if text.contains("slicc: refused:") { "other-slicc-refusal" } else { "other-error" }))
}

fn tree(value: &Value) -> Value {
    let frame = &value["frame"];
    json!({
        "fields":frame.as_object().map(|item| item.keys().collect::<Vec<_>>()),
        "url":origin(&frame["url"]),
        "unreachableUrl":origin(&frame["unreachableUrl"]),
        "securityOrigin":origin(&frame["securityOrigin"]),
        "parent":frame.get("parentId").is_some(),
        "children":value["childFrames"].as_array().map(|items| items.iter().map(tree).collect::<Vec<_>>()),
    })
}

pub fn reply(result: &Result<Value, String>) -> Value {
    match result {
        Ok(value) => json!({
            "fields":value.as_object().map(|item| item.keys().collect::<Vec<_>>()),
            "frameTree":value.get("frameTree").map(tree),
            "targetInfo":value.get("targetInfo").map(|item| json!({"type":item["type"],"url":origin(&item["url"])})),
        }),
        Err(message) => json!({"error":error(message)}),
    }
}
