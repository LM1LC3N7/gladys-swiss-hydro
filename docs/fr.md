# Swiss Hydro pour Gladys

Connecteur non officiel, sans lien avec l'Office fédéral de l'environnement
(OFEV). Il amène dans Gladys les stations hydrologiques de l'OFEV : l'Aar à
Berne, le Rhône à la Porte du Scex, le Léman, le Rhin à Bâle et environ 230
autres rivières et lacs.

> **État : n'a jamais été testée dans une vraie installation Gladys.** La
> lecture des données a été vérifiée à la main contre les vrais services
> publics pendant le développement (appels en lecture seule, le 2026-10-18),
> mais le module n'a pas encore tourné dans Gladys. Merci de signaler ce que
> vous constatez.

Source : OFEV. Données ouvertes publiques, sans compte ni clé.

## Ce que vous obtenez

Un appareil par station, avec :

| Fonction                | Unité     | Remarques                                                                                                                                      |
| ----------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Débit                   | m³/s      | Valeur simple : Gladys n'a pas d'unité m³/s, elle figure donc dans le nom. Un ruisseau mesuré en l/s est converti. Pas de débit pour les lacs. |
| Niveau                  | m         | La plupart des stations donnent l'altitude de l'eau (m au-dessus de la mer), quelques-unes une hauteur relative.                               |
| Température de l'eau    | °C        | Seulement les stations qui la mesurent. Exclue de la température des pièces de Gladys.                                                         |
| Date de la mesure       | texte     | En heure suisse (« 2026-10-18 05:30 »), quel que soit le fuseau horaire de votre Gladys.                                                       |
| Degré de danger de crue | 1 à 5     | Le degré officiel de l'OFEV : 1 danger nul ou faible, 2 limité, 3 marqué, 4 fort, 5 très fort.                                                 |
| Seuils de danger 2 à 5  | m³/s ou m | Là où commence chaque degré pour cette station (débit pour une rivière, niveau pour un lac), quand l'OFEV les publie.                          |

Une fonction n'apparaît que si la station donne sa valeur. Une fois
l'appareil créé, une fonction n'en disparaît jamais, même si la station cesse
de l'envoyer quelque temps.

## Configuration

1. Installez l'intégration depuis le store, puis ouvrez sa configuration.
2. **Stations** : numéros de stations de l'OFEV, séparés par des virgules,
   par exemple `2135, 2009`. Un nom fonctionne aussi
   (`Rhône Porte du Scex`) s'il ne désigne qu'une station. 20 stations au
   maximum.
3. Pour trouver un numéro, tapez une rivière, un lac ou un lieu dans le
   bouton **Chercher des stations** (par exemple `Rhone` ou `Leman`), ou
   utilisez la [carte de l'OFEV](https://www.hydrodaten.admin.ch/fr/aktuelle-lage).
4. **Source des données** :
   - _Données ouvertes OFEV (LINDAS)_, par défaut : les valeurs et le degré
     de danger officiels, publiés par l'OFEV sur LINDAS, le service de
     données liées de l'administration fédérale.
   - _swisshydroapi (Bouni)_ : le service que lit la bibliothèque
     [swisshydrodata](https://github.com/Bouni/swisshydrodata) (et
     l'intégration Home Assistant), tenu par son auteur. Il connaît plus de
     stations ; le degré de danger est alors calculé à partir des seuils
     officiels.
5. **Intervalle de lecture** : 10 minutes par défaut, 10 au moins (l'OFEV
   mesure toutes les 10 minutes), 60 au plus. Toutes les stations sont lues
   ensemble, en une requête (une requête par station avec swisshydroapi).
6. Cliquez sur **Tester les stations**, puis ajoutez les appareils depuis
   l'onglet Découverte.

## Scènes

Deux déclencheurs :

- **Débit au-dessus de (Swiss Hydro)** : le débit d'une station a atteint la
  valeur choisie (1 à 4 000 m³/s). Il se déclenche une fois par montée, et à
  nouveau seulement après que le débit est redescendu sous 95 % de cette
  valeur. Pour une autre valeur, utilisez le déclencheur d'appareil habituel
  sur la fonction Débit (« valeur supérieure à »).
- **Degré de danger de crue atteint (Swiss Hydro)** : le degré de danger est
  monté au degré choisi (2 à 5). Un saut de 1 à 3 déclenche le degré 2 et le
  degré 3. Il se déclenche à nouveau après une baisse puis une hausse.

La première lecture après l'installation ne fait qu'armer les déclencheurs :
rien ne part parce qu'une rivière est déjà haute au démarrage de Gladys. Leur
état est gardé entre deux redémarrages : rien ne part deux fois. Les deux
donnent la station, son débit, son niveau, la date de la mesure et un résumé
en français et en anglais.

Ces déclencheurs suivent les données publiées, avec jusqu'à 10 minutes de
retard, davantage si le service est en panne : ils ne remplacent jamais les
alertes officielles de l'OFEV et de votre canton
([portail des dangers naturels](https://www.dangers-naturels.ch)).

## Limites et comportement

- Une mesure de plus de 3 heures (station hors service) n'est pas publiée,
  pas plus qu'une mesure à la date aberrante (dans le futur, ou de plus de
  30 jours). Le bouton de test l'affiche quand même.
- Si un service répond « trop de requêtes » (429), l'intégration se met en
  pause le temps demandé (d'une minute à six heures), même après un
  redémarrage. Une erreur ne la fait jamais relire plus vite que
  l'intervalle.
- Les seuils et les unités viennent de la couche cartographique
  d'hydrodaten.admin.ch, lue une fois par jour ; si elle échoue, les valeurs
  continuent sans eux. Avec la source OFEV, une station absente de cette
  couche n'a pas de débit (son unité, m³/s ou l/s, est inconnue) : choisissez
  pour elle la source swisshydroapi.
- Rien n'est envoyé hormis les numéros de stations. L'intégration n'écrit
  que son fichier d'état dans `/data`.

## Crédits

- Données : Office fédéral de l'environnement (OFEV), « Données de mesure
  hydrologiques actuelles de l'OFEV », données ouvertes publiées sur
  [LINDAS](https://lindas.admin.ch), conditions « Open use » d'opendata.swiss ;
  les seuils viennent d'[hydrodaten.admin.ch](https://www.hydrodaten.admin.ch).
- Code : portage en JavaScript de
  [swisshydrodata](https://github.com/Bouni/swisshydrodata) 0.3.1 de Bouni
  (MIT). Voir `THIRD_PARTY_NOTICES.md`.
