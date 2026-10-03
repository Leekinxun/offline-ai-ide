use serde_json::{Map, Value};
use std::{
    fs,
    io::{self, Write},
    path::PathBuf,
};

pub struct Preferences {
    file: PathBuf,
    value: Map<String, Value>,
}

fn valid(key: &str, value: &Value) -> bool {
    match key {
        "theme" => matches!(value.as_str(), Some("light" | "dark")),
        "editorFont" => value.as_str().is_some_and(|text| {
            !text.trim().is_empty()
                && text.encode_utf16().count() <= 256
                && !text.chars().any(|ch| ch <= '\u{1f}' || ch == '\u{7f}')
        }),
        "zoomLevel" => value
            .as_f64()
            .is_some_and(|number| number.is_finite() && (0.7..=1.6).contains(&number)),
        "locale" => value.as_str().is_some_and(|locale| {
            if locale.len() > 64 {
                return false;
            }
            let mut parts = locale.split('-');
            let root = parts.next().unwrap_or("");
            (2..=8).contains(&root.len())
                && root.chars().all(|ch| ch.is_ascii_alphabetic())
                && parts.all(|part| {
                    (1..=8).contains(&part.len())
                        && part.chars().all(|ch| ch.is_ascii_alphanumeric())
                })
        }),
        _ => false,
    }
}

pub fn write_private_atomic(file: &std::path::Path, value: &Value) -> io::Result<()> {
    let directory = file
        .parent()
        .ok_or_else(|| io::Error::other("Invalid state path"))?;
    fs::create_dir_all(directory)?;
    let temporary = directory.join(format!(
        ".{}.{}.tmp",
        file.file_name().unwrap_or_default().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(&temporary)?;
        output.write_all(&serde_json::to_vec_pretty(value)?)?;
        output.write_all(b"\n")?;
        output.sync_all()?;
        drop(output);
        fs::rename(&temporary, file)?;
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result
}

impl Preferences {
    pub fn load(file: PathBuf) -> io::Result<Self> {
        let mut value = Map::new();
        match fs::metadata(&file) {
            Ok(metadata) if metadata.len() <= 16384 => {
                let source = fs::read_to_string(&file)?;
                if let Ok(Value::Object(stored)) = serde_json::from_str(&source) {
                    for (key, item) in stored {
                        if valid(&key, &item) {
                            value.insert(key, item);
                        }
                    }
                }
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        Ok(Self { file, value })
    }

    pub fn get(&self) -> Value {
        Value::Object(self.value.clone())
    }

    pub fn set(&mut self, patch: Value) -> Result<Value, String> {
        let patch = patch.as_object().ok_or("Invalid desktop preferences")?;
        for (key, value) in patch {
            if !valid(key, value) {
                return Err(format!("Invalid desktop preference: {key}"));
            }
        }
        let mut next = self.value.clone();
        for (key, value) in patch {
            next.insert(key.clone(), value.clone());
        }
        let value = Value::Object(next.clone());
        write_private_atomic(&self.file, &value).map_err(|error| error.to_string())?;
        self.value = next;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn patches_merge_atomically_and_reject_unknown_or_invalid_values() {
        let directory =
            std::env::temp_dir().join(format!("crownforge-preferences-{}", uuid::Uuid::new_v4()));
        let file = directory.join("preferences.json");
        let mut preferences = Preferences::load(file.clone()).unwrap();
        preferences.set(json!({"theme":"dark"})).unwrap();
        preferences
            .set(json!({"locale":"zh-CN", "zoomLevel":1.2}))
            .unwrap();
        for patch in [
            json!({"shell":"bash"}),
            json!({"theme":"other"}),
            json!({"zoomLevel":0.6}),
            json!({"locale":"zh-"}),
            json!([]),
        ] {
            assert!(preferences.set(patch).is_err());
        }
        assert_eq!(
            Preferences::load(file).unwrap().get(),
            json!({"theme":"dark","locale":"zh-CN","zoomLevel":1.2})
        );
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_dir_all(directory).unwrap();
    }
}
