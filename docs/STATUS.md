# Status

- Branche: `wip/consumption-tracking`, poussee sur `origin/wip/consumption-tracking`. Lots consommation livres: tarification, estimation, suivi, calibration, rapport billing, stockage opt-in et commandes.
- TACHE 1: README corrige. Observation manuelle du 2026-09-01 conservee comme non couverte par test ou sonde retenue.
- Decisions: badge limite au tour courant; projection versionnee par `schemaVersion`; aucun cout en credits affiche avant calibration nano-AIU; `/copilot-usage` reste point d'acces aux metadonnees riches.

## Contrat client observe

Inspection lecture seule de `dsh-llm-local-token@1.3.2` extrait depuis npm, hors depot. Licence MIT (`LICENSE`).

- Manifeste dans `package.json`, champ `dsh.client`: `inject: ["slots", "locale"]`, `platform: "web"`. Entree serveur: `main: "lib/index.js"`; entree client exportee: `./client: "./lib/client.js"`.
- `dsh.bundle.patch` pointe vers `cordis.patch.yml`, dont l'insertion declare `id: llm-local-token` et `name: dsh-llm-local-token`. Le paquet publie ne contient pas sources ni configuration de build: pipeline exact non verifiable.
- `lib/index.js` appelle `ctx.llm.registerAdapter(...)` et monte `GET /llm-local-token/usage`. `lib/client.js` enregistre `conversation.input.right` via `ctx.slots.inject`; composant recoit `t`, `useLocalTokenUsage`, optionnel `useModelSelection`, `start`, `stop`, `toggle`, `ensureSelection`.
- Le client lit le snapshot via `useLocalTokenUsage`, appelle `start()` et `ensureSelection()` au montage, puis arrete avec `stop()` au demontage. Le controleur fait un premier fetch puis un polling toutes les 15 secondes; mises a jour via `createSnapshotStore`.
- Aucun `useProjection` ni `host.call` observe. Donnees via route HTTP et snapshot local. Avant premiere reponse, route vide ou erreur fetch: composant masque ou affiche donnees absentes; erreurs reseau sont ignorees silencieusement. Provider etranger: badge masque.

## Non verifie

- Integration DSH reelle: chargement du paquet, injection effective du slot, props exactes fournies par runtime et rendu Web.
- Compatibilite de `schemaVersion` avec contrat client existant.
- Requete GitHub Copilot reelle, modele Auto reel, compteurs de tokens, nano-AIU, facturation, calibration et endpoint billing.
- Pipeline de build DSH du client et comportement d'erreur observable dans navigateur.

## Spike client

- Spike ajoute `src/spike-client.ts`, genere par `pnpm build` vers `lib/spike-client.js`, exporte via `./client`; le manifeste suit le contrat observe (`dsh.client.inject` et `platform`, sans `entry`).
- La route host statique `/llm-github-copilot-spike/status` renvoie `{ schemaVersion: 1, loaded: true }`. Client tente une lecture unique et journalise seulement disponibilite, noms de props et booleens `messageId`/`seq`.
- Deux slots declares: `conversation.input.right` et `conversation.chat.turnTail`.
- Verification empirique DSH Web non realisee dans ce depot: aucun profil n'a ete modifie, plugin active ou script DSH execute. Donc chargement effectif, disponibilite de `turnTail`, moment/frequence de rendu, props runtime, identifiant, rechargement et reouverture restent inconnus.
- La voie de repli demeure le composer `conversation.input.right`, limite a la derniere reponse, si `turnTail` ou son identifiant ne sont pas confirmes.

## Prochaines etapes

1. Confirmer avec environnement DSH de test contrat `conversation.input.right`, injection et props.
2. Definir projection versionnee minimale pour metadata du tour courant.
3. Brancher badge apres validation runtime; conserver `/copilot-usage` pour metadonnees riches.
