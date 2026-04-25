# RiskMapper Nepal

## What is this project?

Imagine you live in Kathmandu. Your house is old, made of mud brick, sitting right next to your neighbor's house. If an earthquake hits tomorrow, will your house fall? And if it does — will it take your neighbor's house with it, and then the next one, like dominoes?

Nobody in Nepal has a tool that answers this question with mathematics. RiskMapper is that tool.

It does not look backward at what happened in 2015. It looks forward and asks: *if an earthquake hits tomorrow, which buildings fail first, and which failures trigger a chain collapse through the neighborhood?*

---

## The core idea in simple words

Every building in Kathmandu is a *dot* (we call it a node).

Two buildings that are physically touching share a *line* (we call it an edge).

Together, all the dots and lines form a *graph* — a mathematical map of the city.

Each dot gets a *score* based on four things:


Risk Score = 
  30% × how old the building is
+ 30% × what it is made of (mud, brick, concrete)
+ 25% × how close it is to a fault line
+ 15% × what kind of soil it sits on


A score of 10 = very dangerous. A score of 1 = relatively safe.

Then we simulate: if the highest-scoring building collapses, which of its neighbors are likely to fall next? And their neighbors? This spreading failure is called *cascade failure* and it is modeled using probability mathematics — no guessing, pure math.

Finally we run *Dijkstra's algorithm* on the road network to find which escape routes stay passable after the cascade, and which roads get blocked.

---

## The output

Three things a judge, a government officer, or even a student can see and understand:

1. A map of Kathmandu colored red to green — red means danger, green means safer
2. A simulation — click any building, watch failure spread outward like a wave
3. Evacuation routes — the mathematically safest paths out of each danger zone

---

## What math is used

- *Graph theory* — buildings as nodes, adjacency as edges
- *Weighted scoring* — the four-factor formula above
- *Conditional probability* — P(building B fails | building A already failed)
- *Dijkstra's shortest path* — finding safest evacuation routes
- *Linear algebra* — calibrating the weights using 2015 real damage data

No machine learning. No AI. Pure classical mathematics.

---

## The data — what we have and where it comes from

### 1. Building footprints and structure
*Source:* HOT OpenStreetMap + KLL METEOR survey
*What it gives us:* 8.1 million building polygons across Kathmandu Valley. The KLL METEOR survey specifically has 53,000 buildings with material type, number of floors, and structural system recorded — this directly feeds the material and age terms in the formula.
*Status:* Free, downloadable, verified.

### 2. 2015 earthquake damage data
*Source:* NPC / Kathmandu Living Labs open data portal (eq2015.npc.gov.np)
*What it gives us:* 747,000 household surveys with damage grades 1 through 5 — grade 1 is minor damage, grade 5 is complete destruction. This is our *ground truth*. We use it to calibrate the weights in our formula using least-squares fitting. If our model scores a building as high-risk and the 2015 survey says it was grade 5 damaged, that is a match. We tune the weights until the matches are as high as possible.
*Validation test:* our top 5 highest-risk wards should match the top 5 most-damaged wards from 2015. If they do not, the formula needs adjustment.
*Status:* Free, publicly available.

### 3. Seismic hazard map
*Source:* GEM Global Earthquake Model + USGS 2015 ShakeMap
*What it gives us:* Peak Ground Acceleration (PGA) values across Kathmandu — essentially, how hard the ground shakes in each zone. This feeds the fault_distance term. The 2015 ShakeMap also lets us check which buildings survived the highest shaking intensity, giving us additional calibration data.
*Status:* Free, downloadable.

### 4. Soil type (Vs30)
*Source:* Paudyal et al. 2012 research paper + SAFER project
*What it gives us:* Kathmandu Valley soil classification — soft alluvial soil in the center amplifies earthquake waves significantly. This is the soil term.
*Status:* Partially available — needs rasterization but the research data exists.

### 5. Slope / terrain
*Source:* NASA SRTM 30m DEM (Digital Elevation Model)
*What it gives us:* The slope angle of the ground under each building. Buildings on steep slopes are more vulnerable.
*How to get it:* Free download from NASA Earthdata. Convert to slope layer using one command: gdaldem slope input.tif slope.tif
*Status:* Free, instant download, easy to process.

### 6. Road network
*Source:* OpenStreetMap via Python osmnx library
*What it gives us:* Every road in Kathmandu as a graph — intersections as nodes, road segments as edges. Used for Dijkstra evacuation routing. Edge weights get inflated in high-risk building zones.
*Status:* Downloads in 2 minutes with one line of Python code.

### 7. Ward boundaries and population
*Source:* HDX (UN Humanitarian Data Exchange) + CBS Nepal 2021 Census
*What it gives us:* The 32 ward polygons of Kathmandu Metropolitan City for the heatmap. Population per ward for the risk denominator — more people in a dangerous area = higher priority.
*Status:* Free, downloadable.

---

## What has been done so far

### Done
- Full system architecture designed
- Mathematical formula defined with four factors and calibrated weights
- Cascade propagation algorithm written in Python
- Dijkstra evacuation router implemented
- Proof-of-concept Python script (generate_data.py) that runs the full model on estimated data and outputs risk_data.json
- Mockup dashboard designed in Google Stitch — dark theme, sidebar with ward rankings, Leaflet map placeholder, cascade and evacuation buttons
- README written

### What the proof-of-concept outputs right now
Running python generate_data.py produces a JSON file with:
- Risk scores for all 32 Kathmandu wards
- Cascade failure scenarios for the top 3 most vulnerable wards
- Ward adjacency graph
- Summary statistics (how many wards are critical, high, moderate, low risk)

### What is not done yet
- Connecting real KLL METEOR + NPC 2015 data to replace the estimated scores
- Replacing estimated ward scores with least-squares calibrated weights from real damage data
- Building the real Leaflet.js interactive map
- SRTM slope layer processing
- Live cascade click simulator on real building graph

---

## Why this project is original

Every tool that exists today for Nepal earthquake risk looks backward — it shows what got damaged in 2015. RiskMapper looks forward. It answers a question no existing tool answers: *which buildings are the critical nodes — the ones whose failure triggers the largest cascade — and therefore which ones should the government retrofit first?*

Spending money to retrofit a critical node is mathematically more valuable than retrofitting an isolated vulnerable building. That insight does not exist anywhere in Nepal's current disaster management system.

---

## The data problem — why it is paused

The formula needs per-building data for all of Kathmandu. The KLL METEOR survey has 53,000 buildings with full structural data — excellent, but not the full city. The NPC 2015 dataset has damage outcomes for 747,000 buildings — but damage outcome is not the same as pre-earthquake building characteristics. We can use it to calibrate weights but not as the primary input.

The complete pre-earthquake building inventory (construction year, material, floor count for every building) exists in the Department of Urban Development and Building Construction (DoUDBC) database and the CBS 2011 building census microdata — but neither is publicly downloadable.

*What would unlock this project:* Access to DoUDBC building permits database, or a data-sharing agreement with NSET or CBS Nepal.

---

## Tech stack

- Python — osmnx, networkx, geopandas, pandas, shapely
- JavaScript + Leaflet.js — interactive map frontend
- GDAL — terrain slope processing
- Single HTML file output — no server needed, runs in any browser

---

## Project files


riskmapper-nepal/
├── generate_data.py     — full mathematical model, outputs risk_data.json
├── risk_data.json       — ward scores, cascade scenarios, adjacency graph
├── index.html           — interactive dashboard (in progress)
└── README.md


---

## Sources

- KLL METEOR survey — Kathmandu Living Labs
- NPC 2015 earthquake open data — National Planning Commission Nepal
- GEM Seismic Hazard Map — Global Earthquake Model Foundation
- USGS 2015 Gorkha ShakeMap — United States Geological Survey
- Paudyal et al. 2012 — Seismic microzonation of Kathmandu Valley
- SRTM DEM — NASA Earthdata
- OSM building data — OpenStreetMap / HOT
- Ward boundaries — HDX / UN OCHA
- CBS 2021 census — Central Bureau of Statistics Nepal

---

Built by a student team from Nepal. The math is done. The data is the next step