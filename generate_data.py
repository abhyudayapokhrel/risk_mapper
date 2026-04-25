import json
import math
import random

# ═══════════════════════════════════════════════════════════════
#  RiskMapper Nepal — generate_data.py
#  Outputs risk_data.json with:
#   - 32 ward risk scores
#   - ALL 32 cascade scenarios (precomputed BFS)
#   - Ward adjacency graph
#   - Summary stats
# ═══════════════════════════════════════════════════════════════

random.seed(42)

# (ward_number, name, age_score, material_score, fault_score, soil_score)
# All scores 0.0–1.0. Formula: 0.30×age + 0.30×material + 0.25×fault + 0.15×soil
ward_data = [
    (1,  "Bouddha",         0.55, 0.60, 0.70, 0.80),
    (2,  "Sankhu",          0.70, 0.75, 0.65, 0.75),
    (3,  "Jorpati",         0.60, 0.65, 0.60, 0.70),
    (4,  "Gokarneshwor",    0.50, 0.55, 0.55, 0.60),
    (5,  "Kapan",           0.55, 0.60, 0.50, 0.65),
    (6,  "Tokha",           0.65, 0.70, 0.60, 0.70),
    (7,  "Nagarjun",        0.45, 0.50, 0.45, 0.55),
    (8,  "Gaushala",        0.75, 0.80, 0.75, 0.85),
    (9,  "Chabahil",        0.80, 0.85, 0.80, 0.90),
    (10, "Baneshwor",       0.90, 0.95, 0.90, 0.95),
    (11, "Koteshwor",       0.70, 0.75, 0.70, 0.80),
    (12, "Teku",            0.85, 0.90, 0.85, 0.92),
    (13, "Kalimati",        0.80, 0.85, 0.80, 0.88),
    (14, "Swayambhu",       0.75, 0.80, 0.72, 0.82),
    (15, "Swayambhu West",  0.72, 0.76, 0.68, 0.78),
    (16, "Balaju",          0.65, 0.70, 0.65, 0.72),
    (17, "Maharajgunj",     0.60, 0.65, 0.60, 0.68),
    (18, "Lazimpat",        0.65, 0.70, 0.65, 0.72),
    (19, "Gongabu",         0.85, 0.88, 0.82, 0.90),
    (20, "Samakhushi",      0.78, 0.82, 0.75, 0.85),
    (21, "Bansbari",        0.70, 0.74, 0.68, 0.76),
    (22, "Budhanilkantha",  0.55, 0.60, 0.52, 0.62),
    (23, "Shankhapark",     0.60, 0.65, 0.58, 0.66),
    (24, "Naxal",           0.68, 0.72, 0.65, 0.74),
    (25, "Deopatan",        0.62, 0.66, 0.60, 0.68),
    (26, "Thapathali",      0.82, 0.86, 0.80, 0.88),
    (27, "Tripureshwor",    0.80, 0.84, 0.78, 0.86),
    (28, "Dallu",           0.72, 0.76, 0.70, 0.78),
    (29, "Kirtipur",        0.65, 0.70, 0.62, 0.72),
    (30, "Sitapaila",       0.60, 0.64, 0.58, 0.66),
    (31, "Ichangu Narayan", 0.50, 0.55, 0.48, 0.58),
    (32, "Thankot",         0.45, 0.50, 0.44, 0.54),
]

ward_centroids = {
    1:(27.7215,85.3621), 2:(27.7412,85.4201), 3:(27.7301,85.3812),
    4:(27.7489,85.3701), 5:(27.7389,85.3542), 6:(27.7512,85.3312),
    7:(27.7201,85.2912), 8:(27.7089,85.3512), 9:(27.7189,85.3412),
    10:(27.6989,85.3412),11:(27.6889,85.3512),12:(27.6912,85.3112),
    13:(27.6989,85.3012),14:(27.7089,85.2912),15:(27.7112,85.2812),
    16:(27.7212,85.3012),17:(27.7312,85.3212),18:(27.7189,85.3312),
    19:(27.7412,85.3112),20:(27.7389,85.3212),21:(27.7489,85.3312),
    22:(27.7589,85.3412),23:(27.7112,85.3612),24:(27.7189,85.3512),
    25:(27.7289,85.3712),26:(27.6912,85.3212),27:(27.6989,85.3112),
    28:(27.7089,85.3012),29:(27.6789,85.2812),30:(27.7212,85.2712),
    31:(27.7312,85.2612),32:(27.6912,85.2512),
}

adjacency = {
    1: [2,3,5,25],    2: [1,3,4],          3: [1,2,5,23],
    4: [2,6,22],      5: [1,3,6,17,21],    6: [4,5,7,16,21],
    7: [6,14,15,28],  8: [9,10,11,23,24],  9: [8,10,17,24,25],
    10:[8,9,11,26],   11:[8,10,12,13],     12:[11,13,26,27],
    13:[11,12,14,27], 14:[7,13,15,28],     15:[7,14,16,29,30],
    16:[6,15,17,28],  17:[5,9,16,18,20],   18:[17,19,20,24],
    19:[6,16,18,20],  20:[17,18,19,21],    21:[5,6,20,22],
    22:[4,6,21],      23:[3,8,24,25],      24:[8,9,18,23,25],
    25:[1,9,23,24],   26:[10,12,27],       27:[12,13,26,29],
    28:[7,14,16,29],  29:[15,27,28,30],    30:[15,29,31,32],
    31:[7,30,32],     32:[29,30,31],
}

def compute_risk(age, material, fault, soil):
    return round((0.30*age + 0.30*material + 0.25*fault + 0.15*soil) * 10, 2)

def get_risk_level(score):
    if score >= 8.0: return "critical"
    if score >= 6.5: return "high"
    if score >= 5.0: return "moderate"
    return "low"

def get_color(score):
    if score >= 8.0: return "#e02020"
    if score >= 6.5: return "#f47a1f"
    if score >= 5.0: return "#f0b429"
    return "#2ab96e"

# ── BUILD WARDS LIST ──
wards = []
for ward_num, name, age, mat, fault, soil in ward_data:
    score = compute_risk(age, mat, fault, soil)
    lat, lng = ward_centroids[ward_num]
    wards.append({
        "ward": ward_num,
        "name": name,
        "score": score,
        "level": get_risk_level(score),
        "color": get_color(score),
        "lat": lat,
        "lng": lng,
        "factors": {
            "age_score":           round(age  * 10, 1),
            "material_score":      round(mat  * 10, 1),
            "fault_distance_score":round(fault* 10, 1),
            "soil_score":          round(soil * 10, 1),
        }
    })

wards.sort(key=lambda x: x["score"], reverse=True)
wards_dict = {w["ward"]: w for w in wards}

# ── CASCADE SIMULATION (BFS) ──
def simulate_cascade(start_ward):
    """
    BFS cascade from start_ward.
    P(neighbor fails) = P(current) × (neighbor_score/10) × 0.6
    Stops when probability < 0.05 (5%).
    """
    results = {}
    visited = set()
    queue = [(start_ward, 1.0)]

    while queue:
        current, prob = queue.pop(0)
        if current in visited:
            continue
        visited.add(current)
        results[current] = round(prob, 3)
        if prob < 0.05:
            continue
        for neighbor in adjacency.get(current, []):
            if neighbor not in visited:
                n_score = wards_dict[neighbor]["score"] / 10
                cascade_prob = prob * n_score * 0.6
                queue.append((neighbor, cascade_prob))

    return results

# ── PRECOMPUTE ALL 32 CASCADE SCENARIOS ──
print("Computing cascade scenarios for all 32 wards...")
cascade_scenarios = {}
for w in wards:
    wid = w["ward"]
    cascade_scenarios[str(wid)] = simulate_cascade(wid)
    affected = sum(1 for p in cascade_scenarios[str(wid)].values() if p > 0.3)
    print(f"  Ward {wid:2d} ({w['name']:20s}) score={w['score']} → {affected} wards >30% cascade risk")

# ── OUTPUT ──
output = {
    "wards": wards,
    "adjacency": {str(k): v for k, v in adjacency.items()},
    "cascade_scenarios": cascade_scenarios,
    "stats": {
        "total_wards":       len(wards),
        "critical_count":    sum(1 for w in wards if w["level"] == "critical"),
        "high_count":        sum(1 for w in wards if w["level"] == "high"),
        "moderate_count":    sum(1 for w in wards if w["level"] == "moderate"),
        "low_count":         sum(1 for w in wards if w["level"] == "low"),
        "highest_risk_ward": wards[0]["name"],
        "highest_score":     wards[0]["score"],
    }
}

with open("risk_data.json", "w") as f:
    json.dump(output, f, indent=2)

print("\n✓ risk_data.json written")
print(f"  {output['stats']['critical_count']} critical  "
      f"{output['stats']['high_count']} high  "
      f"{output['stats']['moderate_count']} moderate  "
      f"{output['stats']['low_count']} low")
print(f"\nTop 5:")
for w in wards[:5]:
    print(f"  Ward {w['ward']:2d} {w['name']:20s} {w['score']}/10 — {w['level'].upper()}")
