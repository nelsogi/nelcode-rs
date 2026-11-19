// Nel Code Desktop — state.js : L'état partagé : S (conversations, modèles, réponse en cours…) et UI (petits états de l'interface).
// Les textes (messages, noms) passent toujours par textContent, jamais par innerHTML.

// Les petits états de l'interface, modifiés depuis plusieurs modules (un import ne se réassigne pas).

export const UI = {
  editing: null,        // index du message en modification
  closeOverlay: null,   // ferme la fenêtre ouverte
  sugg: { items: [], sel: 0 },
  contextTimer: 0,
  planCollapsed: false,
  nelcodeAsk: 0,
  importToast: null,
  preparing: false,     // un résumé automatique se prépare avant l'envoi
  budgetWarned: null,   // le mois (« 2026-11 ») déjà averti à 80 % du budget
};
export const S = {
  info: {},            // app_info : dossiers
  settings: {},        // settings.json
  sessions: [],        // toutes les conversations (format de Nel Code C#)
  current: null,       // la conversation affichée
  models: [],
  model: { name: null, loading: null, blockSize: null },
  gen: null,           // la réponse en cours : { session, kind, index, el, text }
  context: null,       // { tokens, blockSize, keptTurns }
  server: { port: null, busy: false },   // le serveur local (API OpenAI)
  providers: [],       // les fournisseurs de modèles distants (sans leurs clés)
};
