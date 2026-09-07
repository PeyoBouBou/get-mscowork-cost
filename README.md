# Polling de l'API cost

## Jeton Bearer

Le jeton est recherche dans cet ordre :

1. le parametre `-BearerToken` ;
2. le fichier `bearer-token.txt` ;
3. la variable d'environnement `COST_API_BEARER_TOKEN`.

Si aucun jeton n'est trouve (ou si le fichier est vide), le script le demande
en saisie masquee puis l'enregistre dans `bearer-token.txt`. Le prefixe
`Bearer` est retire automatiquement s'il est present.

## Lancement

```powershell
.\Invoke-CostPolling.ps1
```

Le script appelle l'URL en GET toutes les 30 secondes.

## Fichier de sortie

Sans `-OutputFile`, le script ecrit dans un fichier journalier
`cost-results-AAAA-MM-JJ.json`. Pour choisir un autre fichier :

```powershell
.\Invoke-CostPolling.ps1 -OutputFile .\resultats.json
```

Si le fichier existe deja et n'est pas vide, le script ajoute d'abord un
separateur portant la date et l'heure de lancement, puis les resultats :

```text
{"exemple":"execution precedente"}
--- 2026-09-07 15:08:11 ---
{"exemple":"execution courante"}
```

Les resultats precedents sont donc toujours conserves.

## Gestion des erreurs

Toute reponse HTTP differente de `200` arrete le script. Le code, le motif et
le corps de la reponse sont affiches en rouge dans la console uniquement :
rien n'est ecrit dans le fichier de trace. Le code de sortie vaut alors `1`.

## Couleurs de la console

- cyan : messages du script ;
- vert : JSON renvoye par l'API ;
- gris fonce : separateur d'execution ;
- rouge : erreurs ;
- jaune : demande de jeton.

## Autres options

```powershell
.\Invoke-CostPolling.ps1 -Once                 # un seul appel
.\Invoke-CostPolling.ps1 -IntervalSeconds 60   # intervalle personnalise
.\Invoke-CostPolling.ps1 -Url 'https://...'    # autre endpoint
```
