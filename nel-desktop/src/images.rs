//! Les images des messages : préparées ici (jamais par l'interface), rangées en fichiers dans le dossier de la
//! conversation (`sessions\{id}\img-….jpg|png`, pas en base64 dans le JSON), envoyées au format OpenAI (`content` en
//! tableau, `image_url` en data URL base64).
//!
//! Préparer une image : PNG, JPEG, WebP ou GIF (première image), reconnue à son contenu ; l'orientation EXIF est
//! appliquée, puis le plus grand côté ramené à `imageMaxSide` (1568 px par défaut), et l'image réencodée : rien des
//! métadonnées d'origine (EXIF, position GPS, profils, textes) ne passe dans le fichier gardé ni dans l'envoi.

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use base64::Engine;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::store::{self, Result};

pub const DEFAULT_MAX_SIDE: u32 = 1568;
pub const MAX_PER_MESSAGE: usize = 5;
const MAX_INPUT: usize = 30 << 20;
const MAX_PIXELS_SIDE: u32 = 20_000;
const JPEG_QUALITY: u8 = 90;

/// Les images d'un envoi : fichiers du dossier de la conversation `session`, pour chaque tour de l'historique (même
/// ordre que `history`) et pour le message.
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Attached {
    pub session: String,
    pub history: Vec<Vec<String>>,
    pub message: Vec<String>,
}

impl Attached {
    pub fn of_turn(&self, i: usize) -> &[String] {
        self.history.get(i).map_or(&[], |v| v.as_slice())
    }
}

/// Le dossier des images de la conversation `id`.
pub fn dir(session: &str) -> Result<PathBuf> {
    if !store::valid_name(session) {
        return Err("conversation sans id valide".into());
    }
    Ok(store::sessions_dir().join(session))
}

/// Un fichier d'image de la conversation : seulement un nom fait par `prepare` (« img-<hex>.jpg|png »).
fn file(session: &str, name: &str) -> Result<PathBuf> {
    let ok = name.strip_prefix("img-").and_then(|r| r.strip_suffix(".jpg").or(r.strip_suffix(".png"))).is_some_and(|h| !h.is_empty() && h.len() <= 32 && h.bytes().all(|b| b.is_ascii_hexdigit()));
    if !ok {
        return Err(format!("nom d'image invalide : {name}"));
    }
    Ok(dir(session)?.join(name))
}

/// Le plus grand côté réglé (Réglages, borné par store::normalize).
pub fn max_side() -> u32 {
    store::load_settings()["imageMaxSide"].as_u64().map_or(DEFAULT_MAX_SIDE, |n| n as u32)
}

/// L'estimation des tokens d'une image (comme Claude : environ largeur × hauteur / 750, l'image étant ramenée à
/// 1,15 mégapixel au plus de son côté). Marquée « estimation » dans l'interface.
pub fn estimate_tokens(width: u32, height: u32) -> u64 {
    let pixels = (width as u64 * height as u64).min(1_150_000);
    pixels.div_ceil(750).max(1)
}

/// Décode, oriente, réduit et réencode `bytes`. Rend (octets, extension, largeur, hauteur).
pub fn convert(bytes: &[u8], max_side: u32) -> Result<(Vec<u8>, &'static str, u32, u32)> {
    if bytes.len() > MAX_INPUT {
        return Err(format!("image trop grosse ({} Mo, {} Mo au plus)", bytes.len() >> 20, MAX_INPUT >> 20));
    }
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(|e| e.to_string())?;
    let format = reader.format();
    if !matches!(format, Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Gif)) {
        return Err("format d'image non pris en charge (PNG, JPEG, WebP ou GIF seulement)".into());
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_PIXELS_SIDE);
    limits.max_image_height = Some(MAX_PIXELS_SIDE);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|e| format!("image illisible : {e}"))?;
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder).map_err(|e| format!("image illisible : {e}"))?;
    img.apply_orientation(orientation);
    if img.width().max(img.height()) > max_side {
        img = img.resize(max_side, max_side, image::imageops::FilterType::Lanczos3);
    }
    // Les photos restent en JPEG ; les captures (PNG, GIF) et la transparence en PNG, sans perte.
    let png = format != Some(ImageFormat::Jpeg) && (format != Some(ImageFormat::WebP) || img.color().has_alpha());
    let mut out = Vec::new();
    let (w, h) = (img.width(), img.height());
    if png {
        let img = if img.color().has_alpha() { DynamicImage::ImageRgba8(img.to_rgba8()) } else { DynamicImage::ImageRgb8(img.to_rgb8()) };
        img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png).map_err(|e| e.to_string())?;
    } else {
        let rgb = img.to_rgb8();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY).encode_image(&rgb).map_err(|e| e.to_string())?;
    }
    Ok((out, if png { "png" } else { "jpg" }, w, h))
}

/// Prépare une image et la range dans le dossier de la conversation. Rend { file, name, width, height, bytes, tokens }.
pub fn prepare(session: &str, bytes: &[u8], name: &str) -> Result<Value> {
    let (out, ext, w, h) = convert(bytes, max_side())?;
    let folder = dir(session)?;
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let mut b = [0u8; 8];
    getrandom::fill(&mut b).expect("générateur aléatoire du système");
    let file = format!("img-{}.{ext}", b.iter().map(|x| format!("{x:02x}")).collect::<String>());
    fs::write(folder.join(&file), &out).map_err(|e| format!("image non enregistrée : {e}"))?;
    // Le nom affiché : celui du fichier d'origine, sans dossier (jamais un chemin).
    let name = Path::new(name).file_name().and_then(|n| n.to_str()).map(str::trim).filter(|n| !n.is_empty()).unwrap_or("image");
    let name: String = name.chars().filter(|c| !c.is_control()).take(80).collect();
    crate::log::info(&format!("image préparée : {w} × {h}, {} Ko", out.len() / 1024));
    Ok(json!({ "file": file, "name": name, "width": w, "height": h, "bytes": out.len(), "tokens": estimate_tokens(w, h) }))
}

/// Prépare une image d'un fichier du PC (glisser-déposer, bouton).
pub fn prepare_path(session: &str, path: &str) -> Result<Value> {
    let p = Path::new(path);
    let len = fs::metadata(p).map_err(|e| format!("{path} : {e}"))?.len();
    if len as usize > MAX_INPUT {
        return Err(format!("image trop grosse ({} Mo, {} Mo au plus)", len >> 20, MAX_INPUT >> 20));
    }
    let bytes = fs::read(p).map_err(|e| format!("{path} : {e}"))?;
    prepare(session, &bytes, path)
}

/// Une image collée : une data URL (`data:image/png;base64,…`) ou du base64.
pub fn prepare_data(session: &str, data: &str, name: &str) -> Result<Value> {
    let b64 = data.split_once(";base64,").map_or(data, |(_, b)| b);
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim()).map_err(|_| "image collée illisible".to_string())?;
    prepare(session, &bytes, name)
}

/// La data URL d'une image de la conversation (affichage : la CSP n'accepte que self et data:).
pub fn data_url(session: &str, name: &str) -> Result<String> {
    let path = file(session, name)?;
    let bytes = fs::read(&path).map_err(|_| format!("image introuvable : {name}"))?;
    let mime = if name.ends_with(".png") { "image/png" } else { "image/jpeg" };
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

pub fn delete(session: &str, name: &str) -> Result<()> {
    match fs::remove_file(file(session, name)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Les tokens estimés d'une image de la conversation (0 si elle n'existe plus).
pub fn file_tokens(session: &str, name: &str) -> u64 {
    file(session, name).ok().and_then(|p| image::image_dimensions(p).ok()).map_or(0, |(w, h)| estimate_tokens(w, h))
}

/// Les tokens estimés d'une data URL (en-tête de l'image seulement), pour les tokens d'entrée sans `usage`.
pub fn data_url_tokens(url: &str) -> u64 {
    let Some((_, b64)) = url.split_once(";base64,") else { return 0 };
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) else { return 0 };
    ImageReader::new(Cursor::new(bytes)).with_guessed_format().ok().and_then(|r| r.into_dimensions().ok()).map_or(0, |(w, h)| estimate_tokens(w, h))
}

/// Le `content` d'un message de l'utilisateur : le texte seul, ou (avec des images) un tableau OpenAI, les images
/// d'abord. Une image disparue devient « [image introuvable : …] ».
pub fn user_content(session: &str, text: &str, files: &[String]) -> Value {
    if files.is_empty() {
        return text.into();
    }
    let mut parts: Vec<Value> = files
        .iter()
        .take(MAX_PER_MESSAGE)
        .map(|f| match data_url(session, f) {
            Ok(url) => json!({ "type": "image_url", "image_url": { "url": url } }),
            Err(_) => json!({ "type": "text", "text": format!("[image introuvable : {f}]") }),
        })
        .collect();
    parts.push(json!({ "type": "text", "text": text }));
    Value::Array(parts)
}

/// Les tokens estimés d'un `content` (texte : 4 caractères par token ; image : son estimation, jamais la longueur du
/// base64).
pub fn content_tokens(content: &Value) -> u64 {
    match content {
        Value::Null => 0,
        Value::String(s) => s.chars().count() as u64 / 4,
        Value::Array(parts) => parts
            .iter()
            .map(|p| match p["type"].as_str() {
                Some("image_url") => data_url_tokens(p["image_url"]["url"].as_str().unwrap_or_default()),
                _ => p["text"].as_str().map_or(0, |t| t.chars().count() as u64 / 4),
            })
            .sum(),
        v => v.to_string().chars().count() as u64 / 4,
    }
}

/// Retire les dossiers d'images sans conversation (une image ajoutée puis jamais envoyée dans une conversation
/// jamais gardée). Seulement des dossiers qui ne contiennent que des images de Nel Code.
pub fn clean_orphans() {
    let root = store::sessions_dir();
    let Ok(entries) = fs::read_dir(&root) else { return };
    for e in entries.flatten() {
        let (path, name) = (e.path(), e.file_name().to_string_lossy().into_owned());
        if !path.is_dir() || !store::valid_name(&name) || root.join(format!("{name}.json")).exists() {
            continue;
        }
        let ours = fs::read_dir(&path).map(|d| d.flatten().all(|f| file(&name, &f.file_name().to_string_lossy()).is_ok())).unwrap_or(false);
        if ours && fs::remove_dir_all(&path).is_ok() {
            crate::log::info("dossier d'images sans conversation retiré");
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// Modèles qui voient les images

/// Le réglage manuel du modèle (`vision` : true/false), sinon la détection gardée (`visionDetected`), sinon rien.
pub fn effective(model: &Value) -> Option<bool> {
    model["vision"].as_bool().or(model["visionDetected"].as_bool())
}

/// Détecte si `model` voit les images : modèles Claude ; Ollama (`POST /api/show`, `capabilities`) ; llama.cpp
/// (`GET /props`, `modalities.vision`). `None` si le serveur ne le dit pas.
pub async fn detect(provider: &Value, model: &str, client: &reqwest::Client, key: Option<String>) -> Option<bool> {
    if crate::remote::is_anthropic(provider) {
        return Some(!model.starts_with("claude-2") && !model.starts_with("claude-instant"));
    }
    let url = provider["url"].as_str()?;
    let root = url.trim_end_matches('/').trim_end_matches("/v1").to_string();
    let timeout = std::time::Duration::from_secs(5);
    let with_key = |r: reqwest::RequestBuilder| match &key {
        Some(k) => r.bearer_auth(k),
        None => r,
    };
    if let Ok(r) = with_key(client.post(format!("{root}/api/show")).json(&json!({ "model": model })).timeout(timeout)).send().await
        && r.status().is_success()
        && let Ok(v) = r.json::<Value>().await
        && let Some(caps) = v["capabilities"].as_array()
    {
        return Some(caps.iter().any(|c| c == "vision"));
    }
    if let Ok(r) = with_key(client.get(format!("{root}/props")).timeout(timeout)).send().await
        && r.status().is_success()
        && let Ok(v) = r.json::<Value>().await
        && let Some(vision) = v["modalities"]["vision"].as_bool()
    {
        return Some(vision);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageEncoder, RgbImage, RgbaImage};

    /// Un JPEG w × h avec un segment EXIF (orientation `orientation`, une description « secrète ») et un commentaire.
    fn jpeg_with_exif(w: u32, h: u32, orientation: u16) -> Vec<u8> {
        let img = RgbImage::from_fn(w, h, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, 128]));
        let mut plain = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut plain, 90).encode_image(&img).unwrap();
        // TIFF big-endian : IFD0 avec Orientation (0x0112) et ImageDescription (0x010E) en ASCII.
        let desc = b"GPS 46.2044N 6.1432E SECRET\0";
        let mut tiff: Vec<u8> = b"MM\0\x2a\0\0\0\x08".to_vec();
        tiff.extend([0, 2]);
        tiff.extend([0x01, 0x12, 0, 3, 0, 0, 0, 1]);
        tiff.extend(orientation.to_be_bytes());
        tiff.extend([0, 0]);
        let offset = 8 + 2 + 12 * 2 + 4;
        tiff.extend([0x01, 0x0e, 0, 2]);
        tiff.extend((desc.len() as u32).to_be_bytes());
        tiff.extend((offset as u32).to_be_bytes());
        tiff.extend([0, 0, 0, 0]);
        tiff.extend(desc);
        let mut app1 = b"Exif\0\0".to_vec();
        app1.extend(tiff);
        let mut seg = vec![0xff, 0xe1];
        seg.extend(((app1.len() + 2) as u16).to_be_bytes());
        seg.extend(app1);
        let com = b"\xff\xfe\0\x10COMMENT SECRET";
        let mut out = plain[..2].to_vec(); // SOI
        out.extend(seg);
        out.extend(com);
        out.extend(&plain[2..]);
        out
    }

    fn has(hay: &[u8], needle: &[u8]) -> bool {
        hay.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn redimensionne_le_plus_grand_cote() {
        let img = RgbImage::from_pixel(3000, 1500, image::Rgb([10, 20, 30]));
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png).write_image(&img, 3000, 1500, image::ExtendedColorType::Rgb8).unwrap();
        let (out, ext, w, h) = convert(&png, 1568).unwrap();
        assert_eq!((ext, w, h), ("png", 1568, 784));
        assert_eq!(image::load_from_memory(&out).unwrap().width(), 1568);
        // Plus petite que le réglage : la taille ne change pas.
        let (_, _, w, h) = convert(&png, 4000).unwrap();
        assert_eq!((w, h), (3000, 1500));
        // Portrait.
        let (_, _, w, h) = convert(&jpeg_with_exif(400, 1000, 1), 500).unwrap();
        assert_eq!((w, h), (200, 500));
    }

    #[test]
    fn metadonnees_retirees_orientation_appliquee() {
        let src = jpeg_with_exif(64, 32, 6); // 6 : tourner de 90° vers la droite
        assert!(has(&src, b"Exif\0\0") && has(&src, b"SECRET"));
        let (out, ext, w, h) = convert(&src, 1568).unwrap();
        assert_eq!(ext, "jpg");
        assert_eq!((w, h), (32, 64), "orientation EXIF appliquée avant de la retirer");
        assert!(!has(&out, b"Exif") && !has(&out, b"SECRET") && !has(&out, b"GPS"), "aucune métadonnée gardée");
        assert!(!out.windows(2).any(|m| m == [0xff, 0xe1]), "pas de segment APP1");
        // PNG avec textes (tEXt) : réencodé sans.
        let mut png = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut png, 8, 8);
            enc.set_color(png::ColorType::Rgba);
            enc.add_text_chunk("Location".into(), "GPS SECRET".into()).unwrap();
            let mut w = enc.write_header().unwrap();
            w.write_image_data(&RgbaImage::from_pixel(8, 8, image::Rgba([1, 2, 3, 100])).into_raw()).unwrap();
        }
        assert!(has(&png, b"SECRET"));
        let (out, ext, ..) = convert(&png, 1568).unwrap();
        assert_eq!(ext, "png", "la transparence reste en PNG");
        assert!(!has(&out, b"SECRET") && !has(&out, b"tEXt"));
    }

    #[test]
    fn formats_refuses_et_gif() {
        assert!(convert(b"<svg xmlns='http://www.w3.org/2000/svg'/>", 1568).unwrap_err().contains("non pris en charge"));
        assert!(convert(b"BM\0\0\0\0", 1568).is_err(), "BMP refusé");
        let mut gif = Vec::new();
        {
            let mut enc = image::codecs::gif::GifEncoder::new(&mut gif);
            for c in [10u8, 200] {
                enc.encode_frame(image::Frame::new(RgbaImage::from_pixel(10, 6, image::Rgba([c, c, c, 255])))).unwrap();
            }
        }
        let (out, ext, w, h) = convert(&gif, 1568).unwrap();
        assert_eq!((ext, w, h), ("png", 10, 6));
        assert_eq!(image::load_from_memory(&out).unwrap().to_rgb8().get_pixel(0, 0)[0], 10, "la première image");
    }

    #[test]
    fn noms_de_fichiers_et_contenu() {
        assert!(file("s1", "img-0a1b.jpg").is_ok() && file("s1", "img-ff.png").is_ok());
        for bad in ["../x.jpg", "img-.jpg", "img-zz.jpg", "img-00.gif", "img-00.jpg/..", "a.jpg"] {
            assert!(file("s1", bad).is_err(), "{bad}");
        }
        assert!(file("../s", "img-00.jpg").is_err());
        assert_eq!(user_content("s1", "salut", &[]), json!("salut"));
        let c = user_content("s-inexistante", "salut", &["img-00.jpg".into()]);
        assert_eq!(c[0]["text"], "[image introuvable : img-00.jpg]");
        assert_eq!(c[1], json!({ "type": "text", "text": "salut" }));
        assert_eq!(estimate_tokens(1000, 1000), 1334);
        assert_eq!(estimate_tokens(1568, 1568), 1534, "ramenée à 1,15 Mpx");
    }

    #[test]
    fn tokens_d_un_contenu() {
        let img = RgbImage::from_pixel(750, 100, image::Rgb([0, 0, 0]));
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png).write_image(&img, 750, 100, image::ExtendedColorType::Rgb8).unwrap();
        let url = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png));
        let content = json!([{ "type": "image_url", "image_url": { "url": url } }, { "type": "text", "text": "x".repeat(40) }]);
        assert_eq!(content_tokens(&content), 100 + 10);
        assert_eq!(content_tokens(&json!("abcdefgh")), 2);
    }

    #[test]
    fn vision_manuelle_avant_detection() {
        assert_eq!(effective(&json!({ "id": "m" })), None);
        assert_eq!(effective(&json!({ "visionDetected": true })), Some(true));
        assert_eq!(effective(&json!({ "visionDetected": true, "vision": false })), Some(false));
    }
}
