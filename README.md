# lidalps3d.fr 

/!\ PROJET ENCORE EN PHASE ALPHA /!\

## But du projet

Une réutilisation open source des données IGN pour obtenir une visualisation
web 3D détaillée des Alpes françaises.

Contactez-moi si vous souhaitez réutiliser mon travail, m'aider, ou signaler
un bug.

## Lexique

- **[WebMercatorQuad](https://www.ogc.org/standards/)** —
  grille de tuilage standardisée (OGC), le découpage Web Mercator utilisé
  aussi bien par les tuiles d'imagerie que par les cellules du terrain ici.
- **[WMTS](https://www.ogc.org/standards/wmts/)** — Web Map Tile Service,
  standard OGC de diffusion d'images découpées en tuiles (c'est comme ça que
  l'imagerie IGN est servie).
- **[3D Tiles](https://www.ogc.org/standard/3dtiles/)** — standard OGC pour
  diffuser de grandes scènes 3D sous forme de tuiles, avec niveaux de détail.
- **[glTF / .glb](https://www.khronos.org/gltf/)** — format standard de
  maillage 3D ; `.glb` est sa variante en un seul fichier binaire.
- **[LiDAR HD](https://geoservices.ign.fr/lidarhd)** — programme IGN de
  relevé LiDAR aérien haute densité (le nuage de points source).
- **[RGE ALTI](https://geoservices.ign.fr/rgealti)** — modèle numérique de
  terrain IGN (grille régulière d'altitudes), ici en résolution 5 m.
- **[iTowns](https://github.com/iTowns/itowns)** — moteur de rendu 3D web
  (basé sur three.js) utilisé par la webapp.

## Third parties

- **IGN** — LiDAR HD, RGE ALTI, WMTS (orthophotos, plan IGN)
- **[Camptocamp](https://www.camptocamp.org/)** — points d'intérêt, topoguide,
  recherche
- **[PoissonRecon](https://github.com/mkazhdan/PoissonRecon)** — reconstruction
  de surface à partir du nuage de points
- Inspiration pour la generation du terrain / le calcul des normals + arcitecture de base du builder C++ :
  [OscarPilote/LidarTerrainMesh](https://github.com/oscarpilote/LidarTerrainMesh)

Détails complets des licences et des dépendances vendorisées :
[NOTICE.md](NOTICE.md).

## Remarque

Utilisation de [Claude](https://claude.ai) pour l'implementation.


## TODO

- Meilleure CI et tests
- Mettre à jour les scripts d'installation (`project.toml` / `environment.yml` pas à jour.)
- Enrichir la base de données (couverture LiDAR HD)

## Comment construire des tiles ?

Le terrain se construit avec une petite GUI :

```
python alpineview_builder/gui/main.py
```

1. Dessiner un rectangle sur la carte (bouton "Select rect") pour choisir la
   zone à construire.
2. Vérifier les chemins (exécutables `builder`/`coarse`, dossier RGE ALTI,
   dossier de sortie) et les options (`processes`, `force rebuild`).
3. Cliquer sur "Build". La GUI enchaîne : reconstruction fine (LiDAR HD),
   reconstruction grossière (RGE ALTI), puis l'assemblage du tileset
   (`ogc3d_tiler`).


--> `terrainPack.json` est mis à jour ainsi que les fichiers .glb.

## Workflow de build

```
   LiDAR HD (.laz)              RGE ALTI 5 m (.asc)
         |                            |
         v                            v
   alpineview_builder          alpineview_coarse
   (Poisson Recon + nettoyage / simplification / découpe)
         \                            /
          \                          /
           v                        v
              tuiles .glb (position seule)
                        |
                        v
              ogc3d_tiler/build_tileset.py
                        |
                        v
              un seul fichier : tileset + subtrees
              (webapp/src/terrainPack.json)
```

**Système de coordonnées.** Tout le pipeline travaille dans un seul repère :
une projection Mercator centrée sur les Alpes (métrique, sans déformation de la zone couverte), le même découpage que la grille WebMercatorQuad
utilisée par les tuiles d'imagerie IGN.

**Altitude.** Le Z des tuiles reste en NGF69 (l'altitude brute des fichiers
sources) du début à la fin.

**Nommage des tuiles.** 
Le terrain est d'abord découpé en cellules, une par tuile de la grille WebMercatorQuad au niveau CELL_LEVEL (zoom 11). 


A l'intérieur, un sous-dossier par niveau de détail,
puis un fichier par tuile :

```
public/pm/
└── 1024.700/            <- cellule (x.y au niveau CELL_LEVEL)
    ├── 0/0.0.glb
    ├── 1/0.0.glb  1.0.glb  0.1.glb  1.1.glb
    └── subtrees/         <- disponibilité (3D Tiles implicit tiling)
```

**Poisson Recon et post-traitement.** Pour la zone LiDAR HD : nuage de
points → reconstruction de surface implicite (PoissonRecon) → on garde la
composante connexe principale → simplification ("Quadratic Error Metric simplication") → découpe aux limites exactes de la tuile. Le maillage
final ne contient que les positions ; les normales sont recalculées côté
client.

**RGE ALTI 5 m vs nuage de points.** Au dela d'un certain niveau de detail (Zoom 15). 
Utiliser la precision du nuage de point est inutile, il est plus rapide d'tiliser les donnees de RGE ALTi 5m.

**Le tileset 3D Tiles.** `ogc3d_tiler/build_tileset.py` Relit que les
`.glb` déjà produits en un tileset.

Je suis plus ou moins la norme:
https://github.com/CesiumGS/3d-tiles/blob/main/specification/ImplicitTiling/README.adoc

Au détails pres que le tout est ecrit en un seul fichier .json, commité directement dans le repo.


## Workflow de la webapp

*(on se limite ici à la partie terrain — pas les contrôles caméra, l'UI, etc.)*

```
  terrainPack.json (1 requête)
         |
         v
  tuiles 3D Tiles (.glb) chargées à la volée par iTowns
         |
         v
  UV calculées pour chaque sommet (repère terrain -> Mercator)
         |
         v
  tuile WMTS IGN (ortho ou plan) récupérée et plaquée sur le maillage
```

**Système de coordonnées.** La webapp reste dans le même repère que le
builder (Mercator recentré, métrique) — un seul décalage global est appliqué
au chargement pour garder la scène proche de l'origine (précision GPU), rien
de plus.

**Des 3D Tiles à la tuile texturée.** Quand iTowns charge un maillage, on
calcule la position réelle de chaque sommet sur la grille Mercator, on en
déduit des UV, puis on va chercher la tuile WMTS IGN correspondante (même
grille, donc correspondance directe, sans mosaïquage) pour la plaquer comme
texture.

**Camptocamp.** En parallèle du terrain, la webapp interroge l'API
Camptocamp pour afficher les points d'intérêt (sommets, refuges...) et
permettre une recherche — une couche indépendante du terrain, purement
informative.
