/* =============================================================
   mantis_equipment_data.js
   Mantis Gardens — Equipment Data
   Edit this file to update vehicles, tools, and daily items.
   ============================================================= */

// =============================================================
// VEHICLE DATA
// =============================================================
const VEHICLES = [
  {
    name:    "RAM 2500 'Big Horn' — Install Truck",
    role:    "Install Team — primary work truck",
    year:    "2021",
    detail:  "RAM 2500 Turbo-Diesel 'Big Horn' · 6.7L · 8ft bed · CrewCab 4×4",
    vin:     "3C6UR5JL0MG628257",
    crew:    "Install Team (Khuwaja / Robert)",
    service: [
      "Oil: fully synthetic 5W-40 · change every 7,500–10,000 miles",
      "Last oil change: 1/24/2025 at 54,000 mi · next est. 62,000 mi",
      "Fuel filters last changed: 4/5/2025",
      "Last tire rotation: 61,058 mi",
    ],
    specs: [
      "Towing max: 18,230 lbs",
      "Payload max (passengers + cargo): 2,310 lbs",
      "Curb weight: 7,012 lbs",
      "GVWR: 10,000 lbs",
    ]
  },
  {
    name:    "Taco 1 — Maintenance Team 1",
    role:    "Maintenance Team 1",
    year:    "2017",
    detail:  "Toyota Tacoma TRD Off-Road 4×4 · V6 · double cab · long bed · tow package",
    vin:     "3TMDZ5BN5HM021027",
    crew:    "Team 1 (Chewy)",
    service: [
      "Oil: fully synthetic 0W-20 or 5W-20 · change every 5,000–7,500 miles",
      "Last oil change: 9/12/2025 at 66,718 mi · next est. 71,718 mi",
      "Last tire rotation: 69,052 mi",
      "Smog due: 3/31/2026",
    ],
    specs: [
      "Towing max: 6,400 lbs",
      "Bed load max: 1,175 lbs",
      "Curb weight: 4,425 lbs",
    ]
  },
  {
    name:    "Taco 2 — Maintenance Team 2",
    role:    "Maintenance Team 2",
    year:    "2017",
    detail:  "Toyota Tacoma TRD Off-Road 4×4 · V6 · double cab · long bed · tow package",
    vin:     "5TFRZ5CN4HX028064",
    crew:    "Team 2 (Adrian & Michael)",
    service: [
      "Oil: fully synthetic 0W-20 or 5W-20 · change every 5,000–7,500 miles",
      "Last oil change: 11/7/2025 at 75,063 mi · next est. 80,063 mi",
      "Last tire rotation: 76,585 mi",
      "Engine air filter: recently changed (see sheet)",
    ],
    specs: [
      "Towing max: 6,400 lbs",
      "Bed load max: 1,175 lbs",
      "Curb weight: 4,425 lbs",
    ]
  },
  {
    name:    "Personal Car — Brooke",
    role:    "Maintenance — Brooke",
    year:    "—",
    detail:  "Personal vehicle",
    vin:     "—",
    crew:    "Brooke Wolf",
    service: [], specs: []
  },
  {
    name:    "Dump Trailer",
    role:    "Install — debris hauling",
    year:    "—",
    detail:  "PAC West dump trailer",
    vin:     "1P9UF1028RN145672",
    crew:    "Install Team",
    service: [],
    specs: [
      { label:"GVWR",         value:"9,995 lbs (Pac West range: 9,995–14,000 lbs — confirm on VIN plate)" },
      { label:"Hoist",        value:"18,000 lb hydraulic cylinder (power up/down)" },
      { label:"Axles",        value:"2 × 5,200 lb electric brake axles (9,995 lb model)" },
      { label:"Coupler",      value:'2-5/16" adjustable' },
      { label:"Brakes",       value:'12" electric on both axles' },
      { label:"Elec. plug",   value:"7-Way RV" },
      { label:"Note",         value:"GVWR, payload & bed size stamped on VIN plate on tongue. Pac West custom-built — call 916-487-4483 for exact build sheet." }
    ]
  },
  {
    name:    "Flat Trailer (5×8)",
    role:    "Maintenance / Install — materials",
    year:    "—",
    detail:  "BigTex flat trailer",
    vin:     "16V1U176R2319793",
    crew:    "All teams",
    service: [],
    specs: [
      { label:"Year",         value:"2024 (VIN position 10 = 'R')" },
      { label:"Model",        value:"Big Tex 10ET Pro Series — Tandem Axle Equipment Trailer" },
      { label:"GVWR",         value:"9,990 lbs" },
      { label:"Axles",        value:"2 × 5,200 lb cambered, EZ-Lube w/ electric brakes (Dexter)" },
      { label:"Suspension",   value:"Multi-leaf slipper spring w/ equalizer" },
      { label:"Deck width",   value:'83" (6\'11")' },
      { label:"Coupler",      value:'Adjustable forged 2-5/16"' },
      { label:"Jack",         value:"8,000 lb drop-leg" },
      { label:"Tires",        value:'ST225/75 R-15 Load Range D, 15" × 6" black mod 6-bolt' },
      { label:"Elec. plug",   value:"7-Way RV" },
      { label:"Frame",        value:'5" channel' },
      { label:"Dovetail",     value:'36" cleated' },
      { label:"Payload",      value:"~7,570–7,670 lbs (GVWR minus trailer weight; varies by deck length)" },
      { label:"Hitch type",   value:"Bumper pull" }
    ]
  },
  {
    name:    "Kubota Mini-Excavator",
    role:    "Install — excavation & heavy lifting",
    year:    "—",
    detail:  "Kubota compact loader",
    vin:     "KBXLCLA1UKRLM18878",
    crew:    "Install Team",
    manual:  "https://www.kubotausa.com/parts-service",
    manual_note: "Operator manual available via myKubota app or Kubota Literature Store. Bring serial KBXLCLA1UKRLM18878 to dealer.",
    attachments: [
      "Pallet Fork — LPAP-CPF1242 (S/N 1184110K)",
      "Large Bucket — AP-CL148HC (S/N 1194338K)",
      "Small Bucket — AP-CL136LT (no S/N)",
      "Trencher — AP-CTR1036 (S/N 1193184K)"
    ],
    service: [], specs: []
  },
];



// =============================================================
// POWER TOOL DATA
// =============================================================
const POWER_TOOLS = [
  // ── Saws ────────────────────────────────────────────────────
  { name:'Sawzall (Reciprocating Saw)', brand:'Makita XRJ05', count:2,
    serial:'(776112)(0750760)', category:'power',
    manual:'https://makitatools.com/products/details/XRJ05M',
    manual_pdf:'https://cdn.makitatools.com/apps/cms/doc/prod/XRJ/7c474299-796c-4e0a-a7a4-a5d36ea29364_XRJ05_IM_885449A940_B4275.pdf' },
  { name:'Electric Chainsaw 18"', brand:'Stihl MSA 220C', count:1,
    serial:'448939038', category:'power',
    manual:'https://www.stihlusa.com/products/chain-saws/battery-saws/msa220cb',
    manual_pdf:'https://cdnassets.stihlusa.com/1625856329-stihl-msa-220-c-owners-instruction-manual.pdf' },
  { name:'Stihl Chainsaw (mini)', brand:'Stihl MS 651 / Rollomatic E Mini', count:1,
    serial:'11309673402M', category:'power',
    manual:'https://www.stihlusa.com/en/support-events/owners-manuals',
    manual_pdf:'resources/Stihl_Rollomatic_MS651_Manual.pdf' },
  { name:'Circular Saw', brand:'Makita XSH03', count:1,
    serial:'0339906Y', category:'power',
    manual:'https://makitatools.com/products/details/XSH03Z',
    manual_pdf:'https://cdn.makitatools.com/apps/cms/doc/prod/XSH/2bf4476b-7748-460e-a029-7cc92d315582_XSH03M_IM.pdf' },
  { name:'Miter Saw', brand:'Bosch GCM12SD', count:1,
    serial:'226002621', category:'power',
    manual:'https://www.boschtools.com/us/en/products/gcm12sd-060166501C',
    manual_pdf:'https://www.boschtools.com/us/en/ocsmedia/2610051827_GCM12SD_0918.pdf' },
  { name:'Table Saw', brand:'Bosch 4100XC', count:1,
    serial:'232000706', category:'power',
    manual:'https://www.boschtools.com/us/en/products/4100xc-10-0601B13016',
    manual_pdf:'https://www.boschtools.com/us/en/ocsmedia/2610016770_0712_41004100DG.pdf' },
  { name:'PVC Saw', brand:'—', count:3, category:'power' },
  // ── Drills & drivers ────────────────────────────────────────
  { name:'Cordless Drill', brand:'Makita XFD10 / XPH03', count:2,
    serial:'Serial Destroyed, 1551866', category:'power',
    manual:'https://makitatools.com/products/details/XFD10Z',
    manual_pdf:'https://cdn.makitatools.com/apps/cms/doc/prod/XFD/93ddc379-368a-4f6c-a371-c8ee6dcafc6a_XFD10_IM.pdf' },
  { name:'Impact Driver', brand:'Makita XDT12 / XD214', count:2,
    serial:'96276, 670739', category:'power',
    manual:'https://makitatools.com/products/details/XDT12Z',
    manual_pdf:'https://cdn.makitatools.com/apps/cms/doc/prod/XDT/93c9bb02-00ce-4f5b-9431-9186ebbbe8fa_XDT12_IM_885516-941.pdf' },
  { name:'Milwaukee Drill (13mm)', brand:'Milwaukee', count:1,
    serial:'A15DD 244300814', category:'power',
    manual:'https://www.milwaukeetool.com/Products/Power-Tools/Drilling' },
  { name:'Concrete Drill', brand:'Makita HR2641', count:1,
    serial:'201209', category:'power',
    manual:'https://makitatools.com/products/details/HR2641',
    manual_pdf:'https://cdn.makitatools.com/apps/cms/doc/prod/HR2/4e2a5009-27ed-4376-9273-f841b8a96562_HR2641_IM.pdf' },
  // ── Grinding & cutting ───────────────────────────────────────
  { name:'Cordless Grinder 18V', brand:'Makita XAG26Z', count:2,
    serial:'(62768Y)(124839Z)', category:'power',
    manual:'https://makitatools.com/products/details/XAG26Z',
    manual_pdf:'https://cdn.makitatools.com/apps/cms/doc/prod/XAG/55917cfe-3941-4aec-a517-a30d53acf3ea_XAG26_IM_885761-900.pdf' },
  { name:'Corded Grinder', brand:'Makita 9564/9565', count:1,
    serial:'131213A', category:'power',
    manual:'https://makitatools.com/products/details/9564',
    manual_pdf:'resources/Makita_Corded_Grinder_Manual.pdf' },
  { name:'Concrete Saw', brand:'Makita XEC01', count:1,
    serial:'6333', category:'power',
    manual:'https://makitatools.com/products/details/XEC01PT',
    manual_pdf:'resources/Makita_Concrete_Saw_Manual.pdf' },
  { name:'Jackhammer', brand:'Makita HM1307CB', count:1,
    serial:'56572', category:'power',
    manual:'https://makitatools.com/products/details/HM1307CB',
    manual_pdf:'https://cdn.makitatools.com/apps/cms/doc/prod/HM1/1ae22332-9568-4b2d-978a-0930b21dbd2d_HM1317CB_IM.pdf' },
  // ── Sanders & finishing ──────────────────────────────────────
  { name:'Large Orbital Sander', brand:'Makita BO6050', count:1,
    serial:'82829', category:'power',
    manual:'https://makitatools.com/products/details/BO6050',
    manual_pdf:'https://cdn.makitatools.com/apps/cms/doc/prod/BO6/2c745044-9c9e-4e21-915e-e522a0722ec4_BO6050_IM.pdf' },
  { name:'Orbital Sander', brand:'Makita XOB01Z', count:2,
    serial:'(0506080Y)(0268276Y)', category:'power',
    manual:'https://makitatools.com/products/details/XOB01Z',
    manual_pdf:'https://cdn.makitatools.com/apps/cms/doc/prod/XOB/04695864-b338-47c7-a6fa-7a3145944140_XOB01_IM.pdf' },
  { name:'Hand Sander', brand:'N/A', count:2, category:'power' },
  { name:'Belt Sander', brand:'Makita 4X24', count:1,
    serial:'254509G', category:'power',
    manual:'https://makitatools.com/products/details/9403',
    manual_pdf:'https://cdn.makitatools.com/apps/cms/doc/prod/940/dfc4d058-14aa-47c7-aa01-ca19ebfd88e2_9403_IM.pdf' },
  { name:'Multi Tool', brand:'Makita XMT03Z', count:1,
    serial:'1309122Y', category:'power',
    manual:'https://makitatools.com/products/details/XMT03Z',
    manual_pdf:'https://cdn.makitatools.com/apps/cms/doc/prod/XMT/62c066e7-cd9f-4110-bea1-b6693324837c_XMT03Z_IM.pdf' },
  { name:'Jig Saw', brand:'Makita XVJ01Z', count:1,
    serial:'243224G', category:'power',
    manual:'https://makitatools.com/products/details/XVJ01Z',
    manual_pdf:'https://cdn.makitatools.com/apps/cms/doc/prod/XVJ/791dd413-af4d-43f3-b65c-a91da986df6a_XVJ03Z_IM.pdf' },
  { name:'Router', brand:'Makita XTR01Z', count:1,
    serial:'681697Y', category:'power',
    manual:'https://makitatools.com/products/details/XTR01Z',
    manual_pdf:'https://cdn.makitatools.com/apps/cms/doc/prod/XTR/022b9603-6f09-4ceb-b5f1-fc16cd8eeca8_XTR01_IM_C942.pdf' },
  // ── Blower & outdoor ────────────────────────────────────────
  { name:'Blower', brand:'Makita XBU02', count:1,
    serial:'97716A', category:'power',
    manual:'https://makitatools.com/products/details/XBU02Z',
    manual_pdf:'https://cdn.makitatools.com/apps/cms/doc/prod/XBU/7ba1ff53-c2fd-4e3a-b659-2a125995d138_XBU02_IM.pdf' },
  { name:'Pressure Washer', brand:'Greenworks Pro', count:1,
    serial:'GWA1900527', category:'power',
    manual:'https://greenworkstools.zendesk.com/hc/en-us/categories/360006224431-Product-Manuals' },
  { name:'Sod Cutter', brand:'Billy Goat SC182HCA', count:1,
    serial:'60823257', category:'power',
    manual:'https://www.billygoat.com/na/en_us/support/manuals.html',
    manual_pdf:'https://assets.homedepot-static.com/online-rental/tool-assets/v4.2.8/files/Billy-Goat/BGI-SC180H-Operator-Manual.pdf' },
  // ── Surveying & measuring ────────────────────────────────────
  { name:'Topcon Surveying Level', brand:'Topcon RL-H2Sa', count:1,
    serial:'1A083997', category:'power',
    manual:'https://www.topconpositioning.com/support/downloads',
    manual_pdf:'resources/Topcon_RL-H2Sa_Manual.pdf' },
  // ── Heavy equipment ──────────────────────────────────────────
  { name:'Auger (gas powered)', brand:'Tazz', count:1,
    serial:'—', category:'power',
    manual:'https://www.tazzoutdoorproducts.com/pages/owners-manuals',
    manual_pdf:'resources/Tazz_Auger_Manual.pdf' },
  { name:'Gas Auger (manual)', brand:'—', count:1, category:'power' },
  { name:'Mortar Mixer', brand:'Bauer MMXR-3225', count:1,
    serial:'32259001398', category:'power',
    manual:'https://mudmixer.com/pages/support',
    manual_pdf:'https://mudmixer.com/pages/support' },
  { name:'Compactor', brand:'North Star JCP60', count:1,
    serial:'86155', category:'power',
    manual:'https://www.northerntool.com/product-manuals-northstar',
    manual_pdf:'https://assets.northerntool.com/products/491/documents/manuals/49162.pdf' },
  { name:'Mud Mixer', brand:'MMXR-3225', count:1,
    serial:'32259001398', category:'power',
    manual:'https://mudmixer.com/pages/support',
    manual_pdf:'https://mudmixer.com/pages/support' },
  // ── Batteries & accessories ──────────────────────────────────
  { name:'Makita 18V Batteries (5Ah)', brand:'Makita', count:9,
    serial:'—', category:'power',
    manual:'https://makitatools.com/batteries' },
  // ── Misc ─────────────────────────────────────────────────────
  { name:'Pop-up Work Lamp', brand:'Craftsman CMXELAYMPL1029', count:1,
    serial:'5005686', category:'power' },
  { name:'Microwave', brand:'Galanz', count:1,
    serial:'3105816', category:'power' },
];





// =============================================================
// HAND TOOL DATA
// =============================================================
const HAND_TOOLS = [
  // Digging
  { name:'Flat Shovel',                    count:5,  category:'digging' },
  { name:'Spade Shovel',                   count:5,  category:'digging' },
  { name:'Trench / Sharpshooter Shovel',   count:6,  category:'digging' },
  { name:'Digging Bar',                    count:3,  category:'digging' },
  { name:'Pick Mattock',                   count:5,  category:'digging' },
  { name:'Pick Axe',                       count:3,  category:'digging' },
  { name:'Dirt Axe',                       count:1,  category:'digging' },
  { name:'Post Hole Digger',               count:1,  category:'digging' },
  { name:'Post Hole Auger',                count:1,  category:'digging' },
  { name:'Hand Tamper (small)',            count:1,  category:'digging' },
  { name:'Hand Tamper (large)',            count:1,  category:'digging' },
  { name:'Mattock',                        count:1,  category:'digging' },
  // Raking & leveling
  { name:'Hard Rake',                      count:3,  category:'rake' },
  { name:'Tine Rake',                      count:3,  category:'rake' },
  { name:'Concrete Rake',                  count:2,  category:'rake' },
  { name:'Bully Rake',                     count:1,  category:'rake' },
  { name:'Wide Grading Rake',              count:1,  category:'rake' },
  { name:'Push Broom',                     count:3,  category:'rake' },
  { name:'Concrete Brush Broom',           count:1,  category:'rake' },
  { name:'Hula Hoe',                       count:2,  category:'rake' },
  // Pruning
  { name:'Pole Pruner',                    count:3,  category:'pruning' },
  { name:'Pole Lopper / Saw + Extension',  count:3,  category:'pruning' },
  { name:'Hand Pruning Saw',               count:2,  category:'pruning' },
  { name:'Bypass Lopper',                  count:1,  category:'pruning' },
  { name:'Pruners (hand)',                 count:2,  category:'pruning' },
  { name:"Orchard Ladder 5'",              count:1,  category:'pruning' },
  { name:"Orchard Ladder 6'",              count:1,  category:'pruning' },
  { name:"Orchard Ladder 8'",              count:1,  category:'pruning' },
  { name:"Orchard Ladder 10'",             count:1,  category:'pruning' },
  { name:"Orchard Ladder 12'",             count:1,  category:'pruning' },
  // Hauling & hardware
  { name:'Moving Dollies (black)',         count:2,  category:'hauling' },
  { name:'Barrows (blue wheelbarrow)',     count:1,  category:'hauling' },
  { name:'Ramps',                          count:1,  category:'hauling' },
  { name:'Crow Bar',                       count:4,  category:'hauling' },
  { name:'Sledge Hammer',                  count:2,  category:'hauling' },
  { name:'Mini Sledge',                    count:3,  category:'hauling' },
  { name:'Rubber Mallet',                  count:2,  category:'hauling' },
  { name:'Pry Bar',                        count:2,  category:'hauling' },
  { name:'Axe',                            count:1,  category:'hauling' },
  { name:'Magnet Bar',                     count:1,  category:'hauling' },
  { name:'Pitchfork',                      count:4,  category:'hauling' },
  { name:'Poly Scoop',                     count:6,  category:'hauling' },
  { name:'Post Pounder',                   count:1,  category:'hauling' },
  // Irrigation & plumbing
  { name:'1/4" Dripline (6" spacing)',     count:1,  category:'irrigation', detail:'1 roll' },
  { name:'1/2" Poly Line',                 count:1,  category:'irrigation', detail:'30ft section' },
  { name:'1/4" Poly Line',                 count:1,  category:'irrigation', detail:'bucket' },
  { name:'Netafim .4/12"',                 count:1,  category:'irrigation', detail:'10ft' },
  { name:'Swing Pipe',                     count:1,  category:'irrigation', detail:'150ft' },
  { name:'Drip / Poly Repair Kit (full)',  count:1,  category:'irrigation' },
  { name:'PVC Repair Kit',                 count:1,  category:'irrigation' },
  { name:'3/4" PVC Pipe',                  count:1,  category:'irrigation', detail:'10ft section' },
  { name:'Waterproof Wire Nuts',           count:1,  category:'irrigation', detail:'small & medium bottle' },
  { name:'Round-top Staples',             count:5,  category:'irrigation', detail:'5 bags' },
  { name:'RZWC 36"',                       count:3,  category:'irrigation' },
  { name:'200 Mesh Filter 3/4"',           count:1,  category:'irrigation' },
  { name:'Extra Hose + Washing Nozzle',    count:1,  category:'irrigation' },
  // Measuring & fastening
  { name:'Box Level 6ft',                  count:1,  category:'measure' },
  { name:'Box Level 4ft',                  count:2,  category:'measure' },
  { name:'Box Level 2ft',                  count:3,  category:'measure' },
  { name:'6 Inch Level',                   count:1,  category:'measure' },
  { name:'Bubble Level',                   count:2,  category:'measure' },
  { name:'Straight Edge / Triangle',       count:3,  category:'measure' },
  { name:'Fiberglass Tape',                count:1,  category:'measure' },
  { name:'Ratchet Set',                    count:1,  category:'measure' },
  { name:'Wrench Set',                     count:2,  category:'measure' },
  { name:'Adjustable Wrench 18"',          count:1,  category:'measure' },
  { name:'Clamps',                         count:10, category:'measure' },
  { name:'Channel Locks',                  count:3,  category:'measure' },
  { name:'Pipe Wrench',                    count:2,  category:'measure' },
  { name:'PVC Saw',                        count:3,  category:'measure' },
  { name:'Bolt Cutter',                    count:1,  category:'measure' },
  { name:'Crimping Tool',                  count:2,  category:'measure' },
  { name:'Pipe Cutter',                    count:4,  category:'measure' },
  { name:'Hole Saw Set (3", 3.5", 4")',    count:3,  category:'measure' },
  { name:'Chisels',                        count:12, category:'measure' },
  { name:'Stud Finder',                    count:2,  category:'measure', brand:'Dewalt' },
  { name:'Chalk Line',                     count:2,  category:'measure', brand:'Irwin' },
  { name:'Steel Fish Tape',                count:1,  category:'measure' },
  { name:'Wire Cutter (industrial)',       count:2,  category:'measure' },
  { name:'Hatchet',                        count:1,  category:'measure' },
  { name:'Roofing Hammer',                 count:1,  category:'measure' },
  { name:'Bon Paver Extraction Tongs',     count:1,  category:'measure' },
  { name:'Stapler',                        count:2,  category:'measure' },
  // Drill bits & blade sets
  { name:'Milwaukee Cobalt Bit Set',       count:1,  category:'bits', brand:'Milwaukee' },
  { name:'Milwaukee Red Helix Bit Set',    count:1,  category:'bits', brand:'Milwaukee' },
  { name:'Bosch Concrete Bit Set',         count:1,  category:'bits', brand:'Bosch' },
  { name:'Dewalt Wood Bit Set',            count:1,  category:'bits', brand:'Dewalt' },
  { name:'Dewalt Screwdriver Bit Set',     count:1,  category:'bits', brand:'Dewalt' },
  { name:'Ryobi Tap Set',                  count:1,  category:'bits', brand:'Ryobi' },
  { name:'Misc Bits',                      count:10, category:'bits' },
  // Garden & misc
  { name:'Sod Hand Cutters',               count:3,  category:'garden' },
  { name:'Seed Spreader',                  count:1,  category:'garden', brand:"Scott's" },
];



// =============================================================
// DAILY ITEMS CHECKLIST
// =============================================================
const EVERYDAY_ITEMS = [
  'Water jug', 'Electrolyte packets', 'Trash bags (roll)', 'Tarp (large)', 'Tarp (small)',
  'Safety glasses', 'Ear plugs', 'Dust masks', '18V batteries (all)',
  'Colored flags (blue, white, pink)', 'String line + line level',
  'Spray paint (white, orange)', 'Extension cord 50ft', 'Hose + washing nozzle',
  'Caution tape', 'Flagging sticks', 'Cones', 'General tool box',
  'Bar/Chain oil (bottle)', 'Isopropyl dip', 'Vinegar sprayer + mix',
  'Sluggo', 'Sawzall + pruning blade', 'Blower + batteries',
  'Ratchet straps x6', 'Jumper cables', 'Contractor hose (Flexzilla)',
  'Garden hose (Flexzilla)', 'Pressure nozzles x2', 'Cones x3',
  'Pop-up shade structure', 'Tire inflator', 'Rock dolly'
];


// =============================================================