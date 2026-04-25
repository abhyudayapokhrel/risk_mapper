"""
RiskMapper Nepal - fetch_osm_roads.py
Downloads Kathmandu road network from OpenStreetMap via osmnx.
Outputs ktm_roads.json with nodes and edges for browser-side Dijkstra.
"""
import osmnx as ox
import json, math

print("Downloading Kathmandu walking network from OSM...")
print("  (This may take 2-3 minutes)")

# Download walking network for Kathmandu Metropolitan City
G = ox.graph_from_place(
    "Kathmandu Metropolitan City, Nepal",
    network_type="walk"
)

print(f"  Nodes: {G.number_of_nodes()}")
print(f"  Edges: {G.number_of_edges()}")

# Save full graph for reference
ox.save_graphml(G, "ktm_roads.graphml")
print("  Saved ktm_roads.graphml")

# Convert to simplified JSON for browser use
# We only need nodes within our ward area and key connecting edges
# Simplify: keep only intersection nodes (degree > 2)
print("Building browser-ready JSON...")

# Get node data
nodes = {}
for node_id, data in G.nodes(data=True):
    nodes[node_id] = {
        "lat": round(data["y"], 6),
        "lng": round(data["x"], 6),
    }

# Get edge data with lengths
edges = []
for u, v, data in G.edges(data=True):
    length = data.get("length", 100)  # meters
    name = data.get("name", "")
    if isinstance(name, list):
        name = name[0] if name else ""
    highway = data.get("highway", "")
    if isinstance(highway, list):
        highway = highway[0] if highway else ""
    edges.append({
        "u": u,
        "v": v,
        "length": round(length, 1),
        "name": name,
        "type": highway,
    })

# For browser performance, simplify the graph:
# Keep nodes at intersections (degree >= 3) + endpoints
# Merge paths between intersections into single edges
print("Simplifying graph for browser...")
Gs = ox.simplify_graph(G)
print(f"  Simplified: {Gs.number_of_nodes()} nodes, {Gs.number_of_edges()} edges")

s_nodes = {}
for node_id, data in Gs.nodes(data=True):
    s_nodes[str(node_id)] = {
        "lat": round(data["y"], 6),
        "lng": round(data["x"], 6),
    }

s_edges = []
for u, v, data in Gs.edges(data=True):
    length = data.get("length", 100)
    name = data.get("name", "")
    if isinstance(name, list):
        name = name[0] if name else ""
    highway = data.get("highway", "")
    if isinstance(highway, list):
        highway = highway[0] if highway else ""
    # Get geometry if available (for drawing the actual road path)
    geom = None
    if "geometry" in data:
        coords = list(data["geometry"].coords)
        geom = [[round(lat, 6), round(lng, 6)] for lng, lat in coords]
    
    s_edges.append({
        "u": str(u),
        "v": str(v),
        "len": round(length, 1),
        "name": name[:30] if name else "",
        "type": highway,
        "geom": geom,
    })

output = {
    "nodes": s_nodes,
    "edges": s_edges,
    "meta": {
        "source": "OpenStreetMap via osmnx",
        "area": "Kathmandu Metropolitan City, Nepal",
        "network_type": "walk",
        "node_count": len(s_nodes),
        "edge_count": len(s_edges),
    }
}

with open("ktm_roads.json", "w") as f:
    json.dump(output, f, separators=(",", ":"))

fsize = len(json.dumps(output, separators=(",", ":"))) / 1024 / 1024
print(f"\n[OK] ktm_roads.json written ({fsize:.1f} MB)")
print(f"  {len(s_nodes)} nodes, {len(s_edges)} edges")
