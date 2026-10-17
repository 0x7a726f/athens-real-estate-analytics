# Πλατφόρμα Αστικής & Επενδυτικής Ανάλυσης Ακινήτων Αθήνας (v1.0)
**ΕΜΠ — Σχολή ΗΜΜΥ — Τεχνολογία Λογισμικού (Χειμερινό Εξάμηνο 2026–2027)**

Ολοκληρωμένη εφαρμογή Χωρικής & Επενδυτικής Αξιολόγησης Ακινήτων Βραχυχρόνιας Μίσθωσης (Airbnb) στην Αθήνα (`EL300` / `EL001C`), υλοποιημένη και στις δύο απαιτούμενες αρχιτεκτονικές του μαθήματος (**Layered** και **MVC**).

---

## 1. Πηγές Δεδομένων & APIs (Χωρίς Απαίτηση Κλειδιών / Keyless)

1. **Inside Airbnb — Αθήνα (Κατηγορία 9 - Τουρισμός):**
   * Πραγματικά δεδομένα Αθήνας (`2026-09-22` release): **44 επίσημα πολύγωνα γειτονιών** (`neighborhoods.geojson`) και στατιστική επεξεργασία **14.171 ενεργών καταλυμάτων Airbnb** στην Αθήνα (με στρωματοποιημένο δείγμα 345 πραγματικών καταλυμάτων στο `airbnb_listings.geojson`).
2. **Athens GIS Repository & Open-Meteo Geocoding API (Κατηγορία 7 - GIS):**
   * **28 Σημεία Ενδιαφέροντος & Υποδομών (`athens_gis_pois.geojson`)**: 16 Σταθμοί Μετρό/ΗΣΑΠ (Γραμμές 1, 2, 3), 8 Πανεπιστήμια & Σχολεία (ΕΜΠ, ΟΠΑ, ΕΚΠΑ, Πάντειο, ΓΠΑ κ.ά.) και 4 Πολιτιστικά/Τραπεζικά σημεία.
   * **3 Ζώνες Φυσικών Κινδύνων (`athens_gis_hazards.geojson`)**: Ζώνη Πλημμυρικού Κινδύνου Κοίτης Ιλισού, Πρώην Ρέμα Κυψέλης-Πατησίων και Αστική Θερμική Νησίδα Ομόνοιας.
   * **Ζωντανή Γεωκωδικοποίηση (`/api/v1/gis/geocode`)**: Αναζήτηση τοπωνυμίων μέσω Athens GIS + Open-Meteo Geocoding API.
3. **Eurostat — City Statistics / Urban Audit API (Κατηγορία 6 - Στατιστικά):**
   * Ζωντανή σύνδεση με το επίσημο REST API της Eurostat (`JSON-stat 2.0` / `SDMX 3.0`) για τα σύνολα `urb_cpop1` (`DE1001V`), `urb_ctour` (`CR2001V`) και `urb_clivcon` (`SA1001V`) στον επίσημο κωδικό της Αθήνας **`EL001C`** (`Athina - Greater City`), με αυτόματο fallback cache.

---

## 2. Δομή Αποθετηρίου

```text
├── documentation/
│   ├── requirements/
│   │   └── srs-softeng26-XX.md                     # Πλήρες Έγγραφο Προδιαγραφών (SRS) με 7 Use Cases
│   ├── diagram-as-code/
│   │   ├── layered/                                # 7 Διαγράμματα PlantUML (.puml) για Layered
│   │   └── mvc/                                    # 7 Διαγράμματα PlantUML (.puml) για MVC
│   ├── visual-paradigm/                            # Φάκελος για τα ενιαία μοντέλα .vpp
│   └── apis/
│       ├── openapi-v1.yaml                         # Προδιαγραφή OpenAPI 3.0.3
│       └── postman-collection-softeng26-XX.json    # Συλλογή Postman v2.1 με automated tests
├── layered/                                        # Α. Αρχιτεκτονική Πολλαπλών Επιπέδων (Port 8000)
│   ├── backend/                                    # app.py, spatial_service.py, eurostat_connector.py, data_access.py
│   ├── cli/                                        # urban_cli.py
│   ├── data/                                       # Πραγματικά GeoJSON/CSV + fetch_real_datasets.py + seed_database.py
│   ├── frontend/                                   # Responsive UI (Desktop & Smartphone): index.html, app.js
│   └── testing/                                    # test_api_functional.py, test_cli.py, test_performance.py
└── mvc/                                            # Β. Αρχιτεκτονική Model-View-Controller (Port 8001)
    ├── backend/                                    # app.py, controllers.py, models.py
    ├── cli/                                        # urban_mvc_cli.py
    ├── data/                                       # Συγχρονισμένα GeoJSON/JSON data dumps
    ├── frontend/                                   # 2 Ξεχωριστά Views: desktop_view.html (/desktop) & mobile_view.html (/mobile)
    └── testing/                                    # test_mvc_suite.py
```

---

## 3. Οδηγίες Εκτέλεσης & Δοκιμών

### Α. Εκτέλεση Αρχιτεκτονικής Πολλαπλών Επιπέδων (`layered/` — Port `8000`)
```powershell
# 1. Εκκίνηση του Layered Server
python layered/backend/app.py

# 2. Άνοιγμα στον Browser (Responsive για Desktop & Smartphone):
#    http://127.0.0.1:8000

# 3. Εκτέλεση του CLI Εργαλείου:
python layered/cli/urban_cli.py evaluate --lat 37.9648 --lon 23.7265 --radius 600 --rooms 2
python layered/cli/urban_cli.py neighborhoods
python layered/cli/urban_cli.py macro --city EL300
```

### Β. Εκτέλεση Αρχιτεκτονικής Model-View-Controller (`mvc/` — Port `8001`)
```powershell
# 1. Εκκίνηση του MVC Server
python mvc/backend/app.py

# 2. Άνοιγμα των 2 Ξεχωριστών Views στον Browser:
#    - View 1 (Desktop Browser View) : http://127.0.0.1:8001/desktop
#    - View 2 (Smartphone View)      : http://127.0.0.1:8001/mobile

# 3. Εκτέλεση του MVC CLI:
python mvc/cli/urban_mvc_cli.py evaluate --lat 37.9648 --lon 23.7265 --radius 600 --rooms 2
```

### Γ. Εκτέλεση Όλων των Αυτοματοποιημένων Τεστ (Functional, CLI & Performance)
```powershell
python layered/testing/test_api_functional.py
python layered/testing/test_cli.py
python layered/testing/test_performance.py
python mvc/testing/test_mvc_suite.py
```
