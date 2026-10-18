# Swiss Hydro pour Gladys

> **Pas un système d'alerte officiel, ni l'alerte régionale de l'OFEV.** En
> cas de crue, suivez les alertes officielles de l'OFEV et de votre canton
> ([portail des dangers naturels](https://www.dangers-naturels.ch)).

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

| Fonction                                  | Unité     | Remarques                                                                                                                                                                                    |
| ----------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Débit                                     | m³/s      | Valeur simple : Gladys n'a pas d'unité m³/s, elle figure donc dans le nom. Un ruisseau mesuré en l/s est converti. Pas de débit pour les lacs.                                               |
| Niveau                                    | m         | La plupart des stations donnent l'altitude de l'eau (m au-dessus de la mer), quelques-unes une hauteur relative.                                                                             |
| Température de l'eau                      | °C        | Seulement les stations qui la mesurent. Exclue de la température des pièces de Gladys.                                                                                                       |
| Date de la mesure                         | texte     | En heure suisse avec CET ou CEST (« 2026-10-18 05:30 CEST »), quel que soit le fuseau horaire de votre Gladys.                                                                               |
| Degré de danger de crue                   | 1 à 5     | Source OFEV seulement : le degré officiel de l'OFEV, tel que LINDAS le donne (1 danger nul ou faible, 2 limité, 3 marqué, 4 fort, 5 très fort). Jamais calculé ; rien si LINDAS n'en a pas.  |
| Seuils wl_1 à wl_4 de la carte hydrodaten | m³/s ou m | Les valeurs `wl_1` à `wl_4` de la carte d'hydrodaten.admin.ch (débit pour une rivière, niveau pour un lac), supposées être le début des degrés 2 à 5. Affichées seulement, jamais utilisées. |

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
     stations et donne l'unité de chaque valeur, mais pas de degré de danger :
     avec lui, aucun degré de danger n'est publié et le déclencheur de danger
     ne part jamais.
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
- **Degré de danger de crue atteint (Swiss Hydro)** : source OFEV seulement.
  Le degré de danger officiel est monté au degré choisi (2 à 5). Un saut de 1
  à 3 déclenche le degré 2 et le degré 3. Il se déclenche à nouveau seulement
  après être resté 30 minutes en dessous (un degré qui hésite entre 2 et 3
  déclenche le 3 une seule fois).

Rien ne part, les déclencheurs sont seulement armés, à la première lecture
d'une station, après plus de 3 heures sans mesure actuelle, et quand la source
ou l'unité du débit de la station a changé. Leur état est gardé entre deux
redémarrages : rien ne part deux fois. Un événement que Gladys n'a pas pu
prendre (redémarrage, panne) est gardé et renvoyé pendant 30 minutes, puis
abandonné. Les deux donnent la station, son débit, son niveau, la date de la
mesure et un résumé en français et en anglais.

Ces déclencheurs suivent les données publiées, avec jusqu'à 10 minutes de
retard, davantage si un service est en panne : ils ne remplacent jamais les
alertes officielles.

## Limites et comportement

- Une mesure de plus de 3 heures (station hors service) n'est pas publiée,
  pas plus qu'une mesure à la date aberrante (dans le futur, ou de plus de
  30 jours). Le bouton de test l'affiche quand même. Une lecture plus
  ancienne que celle déjà gardée est ignorée.
- Si un service répond « trop de requêtes » (429), l'intégration se met en
  pause le temps demandé (d'une minute à six heures), même après un
  redémarrage. Une erreur ne la fait jamais relire plus vite que
  l'intervalle, redémarrages compris.
- Les seuils et les unités du débit viennent de la couche cartographique
  d'hydrodaten.admin.ch, lue une fois par jour ; une unité une fois connue est
  gardée. **Sans cette couche, la source OFEV ne donne pas de débit** (LINDAS
  ne dit pas si une station est en m³/s ou en l/s) ; les autres valeurs
  continuent. Une station absente de la couche n'a pas de débit avec la
  source OFEV : choisissez pour elle swisshydroapi.
- Si Gladys ne donne pas la configuration au démarrage, l'intégration le dit
  dans son statut et redemande après 1 minute, puis 2, 4… jusqu'à 30.
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
