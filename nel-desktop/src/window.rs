//! La taille, la position et l'état agrandi de la fenêtre, retenus dans settings.json (clé `windowState` ; la clé
//! `window` est celle de Nel Code C#, jamais touchée). Tout en pixels physiques : position extérieure, taille
//! intérieure. Au lancement, un état dont la barre de titre ne tombe sur aucun écran actuel (écran débranché, autre
//! disposition) est ignoré : la fenêtre revient à 80 % de l'écran, centrée (os::initial_window_size).

use std::sync::{Mutex, OnceLock, mpsc};
use std::time::Duration;

use serde_json::{Value, json};
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::store;

pub const KEY: &str = "windowState";

/// Hauteur de la bande du haut (barre de titre) qui doit rester sur un écran, et ce qui doit en être visible au moins.
const TITLE_BAR: i64 = 40;
const MIN_VISIBLE_W: i64 = 120;
const MIN_VISIBLE_H: i64 = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct State {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

impl State {
    /// Un état lu dans les réglages : des nombres entiers, une taille vraisemblable (de 200 × 150 à 20 000 px).
    pub fn from_json(v: &Value) -> Option<State> {
        let int = |k: &str| v[k].as_i64();
        let s = State {
            x: i32::try_from(int("x")?).ok()?,
            y: i32::try_from(int("y")?).ok()?,
            width: u32::try_from(int("width")?).ok()?,
            height: u32::try_from(int("height")?).ok()?,
            maximized: v["maximized"].as_bool().unwrap_or(false),
        };
        ((200..=20_000).contains(&s.width) && (150..=20_000).contains(&s.height)).then_some(s)
    }

    pub fn to_json(self) -> Value {
        json!({ "x": self.x, "y": self.y, "width": self.width, "height": self.height, "maximized": self.maximized })
    }
}

/// Un écran : sa zone utile (sans la barre des tâches), en pixels physiques.
pub type Screen = (i32, i32, u32, u32);

/// La fenêtre est-elle sur un écran ? Il faut qu'au moins 120 × 20 px de sa barre de titre (les 40 px du haut) tombent
/// dans la zone utile d'un écran : sinon on ne pourrait ni la voir ni la déplacer.
pub fn on_screen(s: &State, screens: &[Screen]) -> bool {
    let (x, y, w) = (s.x as i64, s.y as i64, s.width as i64);
    screens.iter().any(|&(sx, sy, sw, sh)| {
        let (sx, sy, sw, sh) = (sx as i64, sy as i64, sw as i64, sh as i64);
        let vis_w = (x + w).min(sx + sw) - x.max(sx);
        let vis_h = (y + TITLE_BAR).min(sy + sh) - y.max(sy);
        vis_w >= MIN_VISIBLE_W && vis_h >= MIN_VISIBLE_H
    })
}

fn screens(w: &tauri::AppHandle) -> Vec<Screen> {
    w.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let a = m.work_area();
            (a.position.x, a.position.y, a.size.width, a.size.height)
        })
        .collect()
}

/// L'état enregistré, s'il tombe sur un des écrans actuels.
pub fn saved(app: &tauri::AppHandle) -> Option<State> {
    let s = State::from_json(&store::load_settings()[KEY])?;
    let ok = on_screen(&s, &screens(app));
    if !ok {
        crate::log::info("fenêtre : position enregistrée hors des écrans actuels, 80 % centrée");
    }
    ok.then_some(s)
}

/// Remet la fenêtre (encore cachée) à la taille et à la position enregistrées : la position d'abord (l'écran et son
/// échelle), puis la taille. L'état agrandi vient après l'affichage (`maximize_if`) : sous Windows, afficher une
/// fenêtre cachée agrandie la remet à sa taille normale.
pub fn apply(w: &WebviewWindow, s: State) {
    let _ = w.set_position(PhysicalPosition::new(s.x, s.y));
    let _ = w.set_size(PhysicalSize::new(s.width, s.height));
    *NORMAL.lock().unwrap_or_else(|e| e.into_inner()) = Some(State { maximized: false, ..s });
}

pub fn maximize_if(w: &WebviewWindow, s: Option<State>) {
    if s.is_some_and(|s| s.maximized) {
        let _ = w.maximize();
    }
}

// La dernière taille et position hors de l'état agrandi : gardées quand la fenêtre est agrandie, pour la rendre à sa
// taille normale au prochain lancement.
static NORMAL: Mutex<Option<State>> = Mutex::new(None);

/// Ce que la fenêtre est maintenant (None si elle est réduite : sa position n'a alors pas de sens).
fn current(w: &WebviewWindow) -> Option<State> {
    if w.is_minimized().unwrap_or(false) {
        return None;
    }
    let maximized = w.is_maximized().unwrap_or(false);
    let mut normal = NORMAL.lock().unwrap_or_else(|e| e.into_inner());
    if !maximized && let (Ok(p), Ok(sz)) = (w.outer_position(), w.inner_size()) {
        *normal = Some(State { x: p.x, y: p.y, width: sz.width, height: sz.height, maximized: false });
    }
    normal.map(|n| State { maximized, ..n })
}

/// Après un déplacement ou un redimensionnement : enregistré quand la fenêtre ne bouge plus depuis 400 ms (un
/// glisser envoie des dizaines d'événements). Pas seulement à la fermeture : un arrêt brutal ne perd rien.
pub fn changed(w: &WebviewWindow) {
    let Some(s) = current(w) else { return };
    static TX: OnceLock<mpsc::Sender<State>> = OnceLock::new();
    let tx = TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<State>();
        std::thread::spawn(move || {
            let mut last: Option<State> = None;
            while let Ok(mut s) = rx.recv() {
                while let Ok(next) = rx.recv_timeout(Duration::from_millis(400)) {
                    s = next;
                }
                if last != Some(s) {
                    save(s);
                    last = Some(s);
                }
            }
        });
        tx
    });
    let _ = tx.send(s);
}

/// À la fermeture : tout de suite.
pub fn closing(w: &WebviewWindow) {
    if let Some(s) = current(w) {
        save(s);
    }
}

fn save(s: State) {
    if let Err(e) = store::update_settings(|v| {
        v[KEY] = s.to_json();
        Ok(())
    }) {
        crate::log::error(&format!("fenêtre : état non enregistré ({e})"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL_HD: Screen = (0, 0, 1920, 1040);

    fn st(x: i32, y: i32, width: u32, height: u32) -> State {
        State { x, y, width, height, maximized: false }
    }

    #[test]
    fn window_state_read_and_written() {
        let s = State { x: -1500, y: 40, width: 1200, height: 800, maximized: true };
        assert_eq!(State::from_json(&s.to_json()), Some(s));
        assert_eq!(State::from_json(&json!({ "x": 1, "y": 2, "width": 900, "height": 600 })).map(|s| s.maximized), Some(false));
        for bad in [json!(null), json!({}), json!({ "x": "1", "y": 2, "width": 900, "height": 600 }), json!({ "x": 1, "y": 2, "width": 50, "height": 600 }),
            json!({ "x": 1, "y": 2, "width": 900, "height": 99999 }), json!({ "x": 1e12, "y": 2, "width": 900, "height": 600 }), json!({ "x": 1, "y": 2, "width": -900, "height": 600 })] {
            assert_eq!(State::from_json(&bad), None, "{bad}");
        }
    }

    #[test]
    fn window_must_be_on_a_current_screen() {
        // Sur l'écran, ou en partie dehors mais avec la barre de titre visible.
        assert!(on_screen(&st(100, 80, 1200, 800), &[FULL_HD]));
        assert!(on_screen(&st(1700, 900, 1200, 800), &[FULL_HD]));
        assert!(on_screen(&st(-1000, 0, 1200, 800), &[FULL_HD]));
        // L'écran de gauche débranché : la fenêtre qui y était est hors des écrans.
        let left = st(-1800, 100, 1200, 800);
        assert!(on_screen(&left, &[FULL_HD, (-1920, 0, 1920, 1040)]));
        assert!(!on_screen(&left, &[FULL_HD]));
        // Barre de titre au-dessus ou au-dessous de l'écran, presque rien de visible, aucun écran.
        assert!(!on_screen(&st(100, -500, 1200, 800), &[FULL_HD]));
        assert!(!on_screen(&st(100, 1030, 1200, 800), &[FULL_HD]));
        assert!(!on_screen(&st(1850, 100, 1200, 800), &[FULL_HD]));
        assert!(!on_screen(&st(100, 80, 1200, 800), &[]));
        // Pas de dépassement avec des valeurs extrêmes.
        assert!(!on_screen(&st(i32::MAX, i32::MAX, 20_000, 20_000), &[FULL_HD]));
        assert!(on_screen(&st(i32::MIN + 5, 0, 20_000, 800), &[(i32::MIN, 0, u32::MAX, 1040)]));
    }
}
