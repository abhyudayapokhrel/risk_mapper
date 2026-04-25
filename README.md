# RiskMapper Nepal

**Status: Paused because of data collection problem. Mathematical framework is completed.**

A forward-looking earthquake cascade failure model for Kathmandu. Unlike existing tools that show historical damage, RiskMapper predicts which buildings will fail next time, and which failures will trigger chain collapses through the neighborhood.

## The math

Every building is a node in a graph. Adjacent buildings share an edge. Each node gets a vulnerability score:

```
V(b) = 0.30 x age + 0.30 x material + 0.25 x fault_distance + 0.15 x soil
```

From this we compute ward-level risk rankings, simulate cascade failure using conditional probability, and find evacuation routes using Dijkstra's algorithm. No ML. No AI. Pure applied mathematics.

## Why it's paused

The formula needs per-building data, construction year, material, and soil type for every building in Kathmandu. This exists inside the Central Bureau of Statistics 2011 census and NSET's building surveys, but is not publicly downloadable. The 2015 earthquake damage portal only has post-quake outcomes, not the pre-quake building characteristics needed for forward-looking scoring.

If you work at NSET, CBS, or DoUDBC and have access to Kathmandu building inventory data, please open an issue.

## What's done

- Vulnerability scoring formula and cascade propagation algorithm
- Graph construction and Dijkstra evacuation router  
- Proof-of-concept dashboard (runs on estimated data until real data is available)

## Run the proof of concept

```bash
pip install osmnx networkx geopandas pandas
python generate_data.py
# open index.html in your browser
```

## Data needed to continue

| Data | Source | Status |
|---|---|---|
| Building inventory (age, material) | CBS 2011 / NSET | Not publicly available |
| Ward boundaries | ICIMOD / Open Knowledge Nepal | Available |
| Road network | OpenStreetMap | Available |
| Fault lines | USGS | Available |

---
