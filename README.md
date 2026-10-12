# Arène — version multijoueur (v17.3)

Noms : **L’Arène** = compétition horaire en ligues ; **Ligue des Traders** = tournoi du mercredi 17 h. Chaque mode a sa page et son **classement mondial** (`/api/league` pour l’Arène, `/api/champ/ranking` pour la Ligue).

## Lancer
    node arena-server.js        # http://localhost:3000   (Node 18+, aucune dépendance)

Le serveur sert `backtest-arena.html` **et** l'API : ouvrir le site via le serveur (pas en double-cliquant le .html).

## Mettre en ligne (centaines de joueurs)
Hébergeur qui fait tourner Node en continu **avec disque persistant** (Render, Railway, Fly.io, VPS…). Pas d'hébergement statique.
- `DATA_DIR` : dossier des données (comptes, ligues, résultats) — sur le disque persistant.
- `TRUST_PROXY=1` : derrière un proxy/CDN (sinon toutes les IP se confondent). On lit l'IP ajoutée par *ton* proxy
  (dernier saut de `X-Forwarded-For`, non falsifiable) ; `TRUSTED_HOPS=2` s'il y a deux proxys (ex. CDN + hébergeur).
- `PORT`, `CREATE_LIMIT` (comptes créés par IP et par heure, 50 par défaut), `UV_THREADPOOL_SIZE` (threads de hachage, auto).
- `/healthz` pour la supervision. `Dockerfile` fourni. **Une seule instance** (état en mémoire + fichier JSON).

## Anti-triche (nouveau)
Le marché est simulé dans le navigateur ; le serveur ne peut pas le rejouer, mais **un score doit se déduire de la liste des trades**.
Chaque manche est envoyée avec ses trades (sens, entrée/sortie, rendement, TP/SL en %, taille, points) et sa courbe d'équité. Le serveur rejette si :
- les frais de la compétition (0,065 % par côté, identiques pour tous) sont validés dans r de chaque TP/SL ;
- le score ne se recalcule pas à partir des trades : 2 × R par trade (R = gain ÷ risque pris, borné −3..+6), bonus de série ±1 à partir de 3 (±3 max), pénalité de 1 point par % de drawdown au-delà de 10 %, liquidation plafonnée à −5, score positif au prorata sous 3 trades, ÷2 si la manche finit en perte, borné −50..+70 ;
- le rendement final ≠ composition des rendements des trades, ou la courbe d'équité ≠ trades (courbe plate hors position, point de départ/arrivée, drawdown) ;
- un TP/SL ne correspond pas à son niveau (`rendement = taille × TP %` exactement), trades qui se chevauchent, plus de 3 trades/jour, taille interdite ;
- le score dépasse ±70 (maximum réel ≈ 63) ;
- le résultat arrive **avant la fin de la manche** (30 min de marché) ou la manche n'a pas été lancée / a déjà été envoyée.
Les séries de TP statistiquement impossibles sont acceptées mais **signalées** ; les rejets et signalements vont dans `db.flags` (fichier `arena-data.json`) et dans les logs (`[triche?]`).
Limite restante : un tricheur motivé peut fabriquer une liste de trades *cohérente*. Seul le moteur de marché côté serveur le bloquerait.

## Tenue en charge (corrigé)
Testé : 500 comptes créés en rafale, compétition complète à 120 joueurs (horloge accélérée), ≈ 3 400 requêtes/s en lecture.
- Hachage `scrypt` **asynchrone** (il bloquait tout le serveur à chaque connexion) ; limites de tentatives sur les échecs seulement.
- Limite de requêtes par compte (et non plus par IP seule) ; création de comptes limitée par IP.
- Écritures disque : un seul écrivain, atomique, seulement si les données ont changé (avant : toutes les 20 s même au repos). `/api/sync` atomique et limité.
- Caches : ladder (10 s), classement général (30 s), lobby (2 s). Diffusions temps réel `lobby`/`sub` regroupées (1 message / 3 s) et rechargements des clients étalés au hasard (plus d'avalanche à chaque inscription).
- Données bornées : détail des manches 3 h, scores 7 jours puis archivés (cumuls conservés), créneaux 48 h → le fichier reste de quelques Mo.
- Page HTML compressée une fois + `ETag` (304) ; `keepAliveTimeout` > proxy (fin des 502 aléatoires) ; erreurs non fatales ; plafonds de connexions temps réel.
- Résultats : score ±200 → ±70, rendement ≤ 1000 %.

## Ce qui est multijoueur
Comptes (scrypt, session 30 j), profil synchronisé, compétition Joueurs horaire (inscriptions 15 min avant, divisions de 20 par ligue, bots uniquement pour les places vides),
montée/descente côté serveur, 3 compétitions/semaine minimum, mode vacances, présence « N en ligne », Arenbot (résultats partagés).

## Limites connues
- Stockage JSON : OK pour quelques centaines de joueurs simultanés ; au-delà SQLite/Postgres + plusieurs instances.
- Pas de réinitialisation de mot de passe (aucun e-mail collecté).
- La ligue Arenbot reste calculée côté client.

## Graphique (contrôles façon TradingView)
- Molette : zoom sur la bougie sous le curseur (au bord droit, l'ancrage reste à droite). Shift + molette ou molette latérale : défilement horizontal.
- Molette sur l'axe des prix (à droite) : échelle des prix. Glisser l'axe : étirer. Double-clic sur l'axe : retour en échelle auto (bouton « A »).
- Glisser dans le graphique : déplacement libre (horizontal = temps, vertical = prix). Glisser l'axe du temps : zoom horizontal ; double-clic : reset.
- Le défilement dans le futur est possible ; bouton ⏭ pour revenir au présent. Si tu remontes dans le passé, la vue reste fixe pendant que la partie avance.
- ⚙ Graphique : sensibilité molette et déplacement, marge à droite, couleurs des bougies, grille, ligne du dernier prix (enregistrés dans le navigateur).
Valable en backtesting libre, compétition et entraînement (même graphique).

## Ligue des Traders (v3.0)
Mercredi 17 h (Europe/Paris), lobby 16 h 55, ouverte dès la Ligue 8 (`CHAMP_MIN_TIER`, 8 par défaut ; 1 = élite, 8 = la plus basse, accès si ligue ≤ seuil). 4 tours + finale à 10 (Arenbots si < 10 en finale directe, < 16 inscrits = finale directe).
Le marché est généré **côté serveur** (une bougie ≈ 15 s, `CHAMP_DAY_MS`) ; le client ne reçoit que les bougies déjà révélées. Les ordres (sens, SL %, TP %, risque ≤ 1 % ; gain ≤ 2 % ; 2 trades par bougie) sont exécutés et valorisés par le serveur : SL prioritaire si SL et TP sont touchés dans la même bougie, drawdown −5 % = éliminé, +10 % = atteint (classé par bougie d'arrivée, puis capital, puis drawdown).
Un tour se ferme dès que le quota est atteint, sinon au plafond (15 min, 20 min en finale) : on complète avec les plus gros profits non éliminés. Lots enregistrés dans `db.users[].rew` et `db.champH` (champion : Elite 3 mois, rangs 2-3 : Pro, finalistes : badge) — à brancher sur les abonnements.
Variables de test : `CHAMP_DAY_MS`, `CHAMP_ROUND_MS`, `CHAMP_FINAL_MS`, `CHAMP_BREAK_MS`, `CHAMP_MIN_TIER`.
Limites : l'événement en cours est en mémoire (un redémarrage pendant la course l'annule) ; une seule instance.

## Marchés simulés réalistes (v14)
Les marchés ne sont plus de simples marches aléatoires. `gen()` (backtest-arena.html) et `mkRound()` (arena-server.js, Ligue des Traders) reproduisent les faits stylisés des vrais marchés :
volatilité qui se regroupe (GARCH + régime lent, effet de levier), queues épaisses (Student t5), saisonnalité intraday propre à chaque classe d'actif (ouverture US, Londres, creux du midi),
news macro et FOMC, gaps (ouverture actions, annonces de résultats), jours de tendance / de range, corrélations entre actifs (NQ/ES, BTC/ETH, EUR/Or…), pas de prix (tick) et mèches issues d'un chemin intra-bougie, volume lié à l'activité.
La volatilité journalière réalisée est recalée sur celle de l'actif. Les données restent **simulées** (déterministes par actif côté backtest) : seul « Or réel · 2 oct. 2025 » est une vraie journée.
Pour de la vraie donnée historique, il faut des CSV 5 min (NQ, ES, BTC…) à brancher à la place de `gen()`.

## Nasdaq 100 réel (v16) + échelles 1m / 3m / W / MN
- Actif **NQR** (« Nasdaq réel ») = vraies bougies USTEC M1 exportées de MT5 (2 janv. → 9 oct. 2026, 274 923 bougies, heure du serveur du broker). Fichier `data/ustec-m1.bin` (2,6 Mo en gzip), servi par `/data/ustec-m1.bin` et chargé au démarrage de la page.
- Le temps est compressé : plus de week-ends ni de pause 00:00–01:00 (1 jour = 1380 bougies M1, 1 semaine = 5 jours). Seuls les jours fériés sans données restent des bougies plates, sautées à la lecture.
- Échelles : réel = 1m, 3m, 5m, 15m, 30m, 1h, 1J, W, MN (pas de 4h : la journée dure 23 h) ; simulé = 5m, 15m, 1h, 4h, 1J, W, MN. **MN = 22 jours de bourse sur le réel, 30 jours sur le simulé** (pas un mois calendaire), W = lundi→dimanche.
- Pour remplacer/mettre à jour les données : `python3 tools/csv2bin.py export_M1.csv data/ustec-m1.bin` (export MT5 « Exporter les barres », séparé par tabulations).
- Le Nasdaq réel est disponible en Backtesting libre (date, scénario et durée s'appliquent) ; la compétition et la Ligue restent sur les marchés simulés.

## Accueil + Tableau de bord (v17)
- **Accueil** (`home()`) : page d'arrivée du site (et lien du logo). Présente le concept, les chiffres clés, 6 chemins rapides (Backtesting libre, Compétition, Ligue des Traders, Arenbot, Entraînement, Tableau de bord) avec compte à rebours en direct (prochaine manche, prochain tournoi, joueurs en ligne), le fonctionnement en 3 étapes et un appel à l'action (créer un compte / reprendre la dernière session).
- **Tableau de bord** (`dash()`, refait) : vue analytique de ta progression avec filtre 7 jours / 30 jours / tout : rendement cumulé, courbe de capital, KPI (win rate, profit factor, espérance, drawdown max, payoff, SL/TP), calendrier d'activité 12 semaines, séries et records, répartition par actif / mode / sens, ligues, avancement des leçons, dernières sessions. État vide soigné avant la première session. Le détail trade par trade reste dans **Analytics**.
- **Bug du démarrage corrigé** : la page graphique était le HTML par défaut et s'affichait pendant le chargement du script (3,9 Mo). Au chargement, seule la page « Accueil » est visible ; le graphique n'apparaît qu'en mode jeu.
- **Menu regroupé** : 4 entrées seulement — Accueil · Jouer ▾ (Backtesting libre, Compétition, Ligue des Traders, Arenbot) · Entraînement · Mon espace ▾ (Tableau de bord, Analytics, Profil). Le menu parent reste en surbrillance quand on est dans une de ses pages.

## Page « Jouer » (v17.1)
Un clic sur **Jouer** dans le menu ouvre une page avec les 4 modes (Backtesting libre, Compétition, Ligue des Traders, Arenbot) en grandes cartes illustrées (`playHub()`, fonds SVG générés par `pjBg()`), avec compte à rebours en direct. Le menu déroulant reste disponible au survol. Pour utiliser de vraies images, remplacer le SVG de `.pjb` par un `background-image` dans `.pjc`.

## Animations, retours de jeu et récompenses (v17.2)
- **Couleurs** plus franches (vert/rouge/bleu), fond animé en dégradé, titre d'accueil animé, boutons avec reflet et ondulation au clic, cartes avec halo qui suit la souris, apparition en cascade des pages, chiffres qui défilent (`fxCount`).
- **Retour de jeu** (`fxTrade`, appelé dans `close()`) : à chaque clôture de trade, flash vert/rouge, gros « +x,xx % » avec message d'encouragement, confettis sur belle série ou gros gain, léger tremblement sur grosse perte. Confettis en fin de session gagnante (`fxEnd`).
- **Récompenses** (accueil, `fxRewards`) : série de jours d'affilée, 12 badges (stockés dans `arena.bd`), progression des leçons, chemin vers l'élite. Un badge débloqué affiche une notification animée.
- **Bandeau défilant** (`fxTicker`) : infos réelles (joueurs en ligne, prochains événements, ta dernière session, ta série, tes badges).
- `prefers-reduced-motion` désactive les animations et les effets.

## 1 contre 1 (v17.9)
Sans compte : « Créer un match » donne un code à 5 caractères, l'adversaire le tape (ou ouvre `?duel=CODE`) et rejoint tout seul. Routes `/api/duel/create|join|start|state|push` (état en mémoire, matchs purgés après 3 h).

## Mode sans serveur (v17.10)
Sans `arena-server.js` (fichier HTML ouvert directement, ou hébergement statique), le jeu bascule seul en **mode local** :
- **Comptes** : enregistrés en JSON dans le navigateur (`localStorage`, clé `arena_local_users`, mot de passe haché PBKDF2). Valables sur cet appareil et ce navigateur uniquement.
- **1 contre 1** : « Créer un match » donne un code à 5 caractères ; l'adversaire le tape dans **un autre onglet du même navigateur** (Chrome conseillé pour un fichier ouvert en double-clic). Deux appareils différents ont besoin du serveur (`node arena-server.js`).
- Si le serveur répond, il reste prioritaire (comptes en ligne, classements, ligues).
