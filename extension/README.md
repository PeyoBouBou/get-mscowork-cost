# Copilot Credits Monitor (extension Chrome)

Extension Chrome/Edge (Manifest V3) qui affiche graphiquement la consommation
de vos credits Copilot, a partir du meme endpoint que `Invoke-CostPolling.ps1` :

```
GET https://<region>.gateway.prod.island.powerapps.com/v1/cost
Authorization: Bearer <jeton de session>
```

## Recuperation du jeton

Aucun jeton n'est demande a l'utilisateur. Le service worker observe les
requetes sortantes (`chrome.webRequest.onBeforeSendHeaders`) vers les hotes
Power Platform ; des que la page appelle `/v1/cost` (ce que fait la commande
`/cost` dans Copilot Studio), l'en-tete `Authorization` est capture et stocke
dans `chrome.storage.local`, avec l'URL exacte de l'endpoint (la region varie
selon le tenant).

- Tant qu'aucun jeton n'a ete vu, le popup n'affiche que le message invitant a
  lancer `/cost`.
- Sur reponse `401`/`403`, le jeton est supprime et le message reapparait.
- Le jeton est un JWT : sa date d'expiration est lue localement et affichee.

## Installation

1. `chrome://extensions` (ou `edge://extensions`) ;
2. activer le **Mode developpeur** ;
3. **Charger l'extension non empaquetee** et selectionner le dossier
   `extension/`.

## Utilisation

1. Ouvrir Copilot Studio et lancer `/cost` dans le chat ;
2. cliquer sur l'icone de l'extension.

Le popup affiche :

- deux jauges circulaires (quota utilisateur et quota de la policy) avec code
  couleur vert / orange / rouge selon le taux d'utilisation ;
- les credits restants sous forme de barres ;
- une courbe d'evolution de la consommation utilisateur (historique local, avec
  la limite en pointilles) ;
- les dates `asOfDate`, `resetOn` (avec compte a rebours), le dernier appel et
  l'etat du jeton.

Le badge de l'icone indique le pourcentage consomme ; il est rafraichi
automatiquement toutes les 15 minutes (`chrome.alarms`) et a chaque ouverture du
popup.

## Donnees et confidentialite

Tout reste local (`chrome.storage.local`) : jeton, derniere reponse et
historique (500 points max). Aucune donnee n'est envoyee ailleurs qu'a
l'endpoint `/v1/cost`. Le bouton **Effacer les donnees locales** vide le
stockage.

## Structure

| Fichier         | Role                                                        |
| --------------- | ----------------------------------------------------------- |
| `manifest.json` | Manifest V3, permissions `webRequest`, `storage`, `alarms`   |
| `background.js` | Capture du jeton, appel de l'API, historique, badge          |
| `popup.html`    | Structure du popup                                           |
| `popup.css`     | Styles (theme clair / sombre automatique)                    |
| `popup.js`      | Rendu des jauges, barres et courbe (canvas, sans dependance) |
