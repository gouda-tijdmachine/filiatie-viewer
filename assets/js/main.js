const SPARQLendpointA = "https://qlever.coret.org/hackalod-filiatie";
const SPARQLendpointB = "https://sparql.goudatijdmachine.nl";

const MAXZOOM = 24;
const huc_knaw_hisgis = L.tileLayer('https://tileserver.huc.knaw.nl/{z}/{x}/{y}', { minZoom: 10, maxZoom: 21, attribution: 'KNAW/HUC' });
const pdok_percelen_BRK = L.tileLayer.wms('https://service.pdok.nl/kadaster/cp/wms/v1_0?', { layers: 'CP.CadastralParcel', transparent: true, version: "1.3.0", maxZoom: MAXZOOM, format: "image/png", attribution: "<a href='https://www.pdok.nl/'>PDOK</a>" });

// Cache DOM elements
let cachedElements = {};

// Regex patterns (compiled once for performance)
const URI_TRIPLE_PATTERN = /<([^>]+)>\s+<([^>]+)>\s+<([^>]+)>\s*\./;
const LITERAL_TRIPLE_PATTERN = /<([^>]+)>\s+<([^>]+)>\s+"([^"]+)"\s*\./;
const PERCEEL_LABEL_PATTERN = /perceel\/([^/]+\/[^/]+)$/;

function strSPARQLb(perceelID) {
    return `PREFIX sdo: <https://schema.org/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>

SELECT ?wkt
WHERE {
  ?sub <https://schema.org/identifier> "${perceelID}"^^xsd:string ;
       geo:hasGeometry/geo:asWKT ?wkt .
}`;
}

function strSPARQLa(perceelID) {
    return `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX gtm: <https://www.goudatijdmachine.nl/def#>

CONSTRUCT {
  ?a gtm:opgegaanIn ?b .
  ?a gtm:hasGeo ?geoa .
  ?b gtm:hasGeo ?geob .
}
WHERE {
  VALUES ?start { <${perceelID}> }
  {
    ?start (gtm:opgegaanIn)* ?a .
    ?a gtm:opgegaanIn ?b .
  }
  UNION
  {
    ?a gtm:opgegaanIn ?b .
    ?b (gtm:opgegaanIn)* ?start .
  }
  ?a rdf:type gtm:Perceel .
  ?b rdf:type gtm:Perceel .
  OPTIONAL {
    ?a gtm:hasGeo ?geoa .
  }
  OPTIONAL {
    ?b gtm:hasGeo ?geob .
  }
}`;
}

// SPARQL execution function
async function executeSPARQL(query, sparqlendpoint) {
    const response = await fetch(sparqlendpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/sparql-query',
            'Accept': 'application/n-triples'
        },
        body: query
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`SPARQL query failed: ${response.status} ${response.statusText}\n${errorText}`);
    }

    return await response.text();
}

// Parse N-Triples format RDF triples into nodes and links
function parseNtriples(turtleText) {
    const nodes = new Map();
    const links = [];

    // Parse N-Triples format: <subject> <predicate> <object> .
    // Each triple is on its own line, no abbreviations
    const lines = turtleText.split('\n');

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) {
            continue; // Skip empty lines and comments
        }

        // Match N-Triples pattern: <subject> <predicate> <object> . or <subject> <predicate> "literal" .
        let match = trimmedLine.match(URI_TRIPLE_PATTERN);
        let object, subject, predicate;

        if (match) {
            // URI object
            [, subject, predicate, object] = match;
        } else {
            // Try matching with literal object
            match = trimmedLine.match(LITERAL_TRIPLE_PATTERN);
            if (!match) {
                continue; // Skip lines that don't match either pattern
            }
            [, subject, predicate, object] = match;
        }

        // Check for hasGeo property
        if (predicate.includes('hasGeo')) {
            // Store the geo data object value
            if (!nodes.has(subject)) {
                nodes.set(subject, {
                    id: subject,
                    label: extractLabel(subject),
                    hasGeo: object
                });
            } else {
                nodes.get(subject).hasGeo = object;
            }
        }

        // Process opgegaanIn relationships (parcel mergers)
        if (predicate.includes('opgegaanIn')) {
            // Add subject node
            if (!nodes.has(subject)) {
                nodes.set(subject, {
                    id: subject,
                    label: extractLabel(subject)
                });
            }

            // Add object node
            if (!nodes.has(object)) {
                nodes.set(object, {
                    id: object,
                    label: extractLabel(object)
                });
            }

            // Add link
            links.push({
                source: subject,
                target: object
            });
        }
    }

    return {
        nodes: Array.from(nodes.values()),
        links: links
    };
}

// Extract readable label from URI
function extractLabel(uri) {
    // Extract "GDA01/N1452" from "https://www.goudatijdmachine.nl/id/perceel/GDA01/N1452"
    const perceelMatch = uri.match(PERCEEL_LABEL_PATTERN);
    if (perceelMatch) {
        return perceelMatch[1];
    }

    // Fallback: return last part of URI
    return uri.split('/').pop();
}

// Helper function to get perceelID from URL hash
function getPerceelFromHash() {
    return window.location.hash ? decodeURIComponent(window.location.hash.substring(1)) : null;
}

// Classify nodes based on their relationship to the start node
function classifyNodes(nodes, links, startURI) {
    const directlyConnected = new Set();

    // Find nodes directly connected to start
    links.forEach(link => {
        const sourceId = link.source.id || link.source;
        const targetId = link.target.id || link.target;

        if (sourceId === startURI) {
            directlyConnected.add(targetId);
        }
        if (targetId === startURI) {
            directlyConnected.add(sourceId);
        }
    });

    return nodes.map(node => ({
        ...node,
        type: node.id === startURI ? 'start'
            : directlyConnected.has(node.id) ? 'next'
                : 'any'
    }));
}

// 3D Graph configuration constants
const GRAPH_CONFIG = {
    START_NODE_SIZE: 12,
    NORMAL_NODE_SIZE: 4,
    START_TEXT_HEIGHT: 8,
    NORMAL_TEXT_HEIGHT: 6,
    LABEL_OFFSET: 8,
    FORCE_CHARGE: -120,
    LINK_DISTANCE: 80,
    CAMERA_Z: 300  // Lower value = closer zoom
};

// Create 3D force-directed graph
function create3DGraph(containerId, nodes, links) {
    const container = document.getElementById(containerId);
    container.innerHTML = ''; // Clear existing content
    container.classList.remove('loading');

    // Create helper function for tooltip HTML
    function createTooltipHTML(d) {
        return `<div style="padding: 8px; background: rgba(0,0,0,0.8); color: white; border-radius: 4px; font-size: 12px;">
            <strong>${d.label}</strong></span>
        </div>`;
    }

    // Create 3D force graph
    const Graph = ForceGraph3D()(container)
        .graphData({ nodes, links })
        .backgroundColor('#3891b1')
        .nodeLabel(d => createTooltipHTML(d))
        .nodeThreeObject(d => {
            // Create a sprite for the permanent label
            const sprite = new SpriteText(d.label);
            sprite.color = d.type === 'start' ? '#d22c25' : '#ffffff';
            sprite.textHeight = d.type === 'start' ? GRAPH_CONFIG.START_TEXT_HEIGHT : GRAPH_CONFIG.NORMAL_TEXT_HEIGHT;
            // Position label below the node sphere
            const nodeSize = d.type === 'start' ? GRAPH_CONFIG.START_NODE_SIZE : GRAPH_CONFIG.NORMAL_NODE_SIZE;
            sprite.position.y = -(nodeSize + GRAPH_CONFIG.LABEL_OFFSET);
            return sprite;
        })
        .nodeThreeObjectExtend(true)
        .nodeColor(d => {
            if (d.hasGeo) {
                return d.hasGeo === "BRK" ? '#FFD700' : '#e17000';
            }
            return d.type === 'start' ? '#d72c29' : '#95a5a6';
        })
        .nodeVal(d => {
            return d.type === 'start' ? GRAPH_CONFIG.START_NODE_SIZE : GRAPH_CONFIG.NORMAL_NODE_SIZE;
        })
        .nodeOpacity(0.9)
        .linkColor(() => '#999')
        .linkOpacity(0.6)
        .linkWidth(1.5)
        .linkDirectionalArrowLength(10.5)
        .linkDirectionalArrowRelPos(1)
        .linkDirectionalArrowColor(() => '#d22c25')
        .onNodeHover(node => {
            container.style.cursor = node ? 'pointer' : 'default';
        })
        .onNodeClick(node => {
            if (node && node.hasGeo) {
                sphereClick(node.id, node.hasGeo);
            }
        });

    // Configure force simulation
    Graph.d3Force('charge').strength(GRAPH_CONFIG.FORCE_CHARGE);
    Graph.d3Force('link').distance(GRAPH_CONFIG.LINK_DISTANCE);

    Graph.cameraPosition({
        z: GRAPH_CONFIG.CAMERA_Z
    });

    return Graph;
}

function sphereClick(perceelID, type) {
    showMap(perceelID, type);
}


// Display error message
function displayError(message) {
    cachedElements.graphDiv.innerHTML = `
        <div class="error-message">
            <strong>Error:</strong> ${message}
        </div>
    `;
}

// Display info message
function displayInfo(message) {
    cachedElements.graphDiv.innerHTML = `
        <div class="info-message">
            ${message}
        </div>
    `;
}

// Main orchestration function
async function loadAndVisualizeGraph() {
    const kadGemeente = cachedElements.kadGemeente.value;
    const kadPerceel = cachedElements.kadPerceel.value;
    const perceelInput = `https://www.goudatijdmachine.nl/id/perceel/${kadGemeente}/${kadPerceel}`;

    // Get perceelID from URL hash or input field
    let perceelID = getPerceelFromHash() || perceelInput;

    if (!perceelID) {
        displayError('Please enter a perceel ID');
        return;
    }

    // Basic URI validation
    if (!perceelID.startsWith('http')) {
        displayError('Perceel ID must be a valid URI (starting with http:// or https://)');
        return;
    }

    // Update URL hash with the perceelID
    window.location.hash = encodeURIComponent(perceelID);

    // Hide controls and show fullscreen graph
    cachedElements.controls.classList.add('hidden');
    cachedElements.beeldmerkb.style.display = "block";
    document.body.style.overflow = 'hidden';

    // Show loading state
    cachedElements.loadButton.disabled = true;
    cachedElements.graphDiv.classList.add('loading', 'visible');
    cachedElements.graphDiv.innerHTML = '<div class="loading-message">De filiatie graaf wordt geladen...</div>';

    try {
        // Execute SPARQL query
        const query = strSPARQLa(perceelID);
        const turtleText = await executeSPARQL(query, SPARQLendpointA);

        // Parse N-Triples results
        const { nodes, links } = parseNtriples(turtleText);

        // Check if we got any data
        if (nodes.length === 0) {
            displayInfo('No data found for this perceel ID. It may not exist in the database or has no connections.');
            return;
        }

        // If only one node and no links, show message
        if (nodes.length === 1 && links.length === 0) {
            displayInfo(`This perceel (${nodes[0].label}) has no connections to other parcels.`);
            // Still render the single node
        }

        // Classify nodes
        const classifiedNodes = classifyNodes(nodes, links, perceelID);

        // Create 3D force-directed graph
        create3DGraph('graph', classifiedNodes, links);

        // Display statistics
        console.log(`3D Graph loaded: ${nodes.length} nodes, ${links.length} edges`);

    } catch (error) {
        console.error('Error loading graph:', error);
        if (error.message.includes('Failed to fetch')) {
            displayError('Cannot connect to SPARQL endpoint. Please check your internet connection.');
        } else {
            displayError(error.message);
        }
    } finally {
        // Re-enable button
        cachedElements.loadButton.disabled = false;

        toonFiliatie(perceelID);
    }
}

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
    // Cache DOM elements for better performance
    cachedElements = {
        kadGemeente: document.getElementById('kadGemeente'),
        kadPerceel: document.getElementById('kadPerceel'),
        loadButton: document.getElementById('loadGraph'),
        graphDiv: document.getElementById('graph'),
        controls: document.getElementById('controls'),
        beeldmerkb: document.getElementById('beeldmerkb'),
        closeButton: document.getElementById('closeGraph'),
        kaartWrapper: document.getElementById('kaart_wrapper'),
        tekstueelWrapper: document.getElementById('tekstueel_wrapper'),
        toonTekstboom: document.getElementById('toonTekstboom')
    };

    cachedElements.loadButton.addEventListener('click', loadAndVisualizeGraph);

    // Auto-load graph if URL has a hash
    if (window.location.hash) {
        loadAndVisualizeGraph();
    }

    // Listen for hash changes (e.g., clicking links or browser back/forward)
    window.addEventListener('hashchange', () => {
        if (window.location.hash) {
            loadAndVisualizeGraph();
        }
    });

    // Close button handler
    cachedElements.closeButton.addEventListener('click', () => {
        // Hide graph and show controls
        cachedElements.graphDiv.classList.remove('visible', 'loading');
        cachedElements.controls.classList.remove('hidden');
        cachedElements.beeldmerkb.style.display = "none";
        document.body.style.overflow = '';

        // Hide map wrapper immediately
        cachedElements.kaartWrapper.classList.remove('visible');
        cachedElements.tekstueelWrapper.classList.remove('visible');

        // Clear the graph container (except the close button)
        while (cachedElements.graphDiv.childNodes.length > 1) {
            cachedElements.graphDiv.removeChild(cachedElements.graphDiv.lastChild);
        }

        // Remove hash from URL
        history.pushState('', document.title, window.location.pathname + window.location.search);
    });

    // Map wrapper handle click handler
    const kaartHandle = document.querySelector('#kaart_wrapper .handle');
    kaartHandle.addEventListener('click', () => {
        cachedElements.kaartWrapper.classList.remove('visible');
    });

    // Text tree wrapper handle click handler
    const tekstHandle = document.querySelector('#tekstueel_wrapper .handle');
    tekstHandle.addEventListener('click', () => {
        cachedElements.tekstueelWrapper.classList.remove('visible');
    });

    // Text tree button handler
    cachedElements.toonTekstboom.addEventListener('click', () => {
        // Close map wrapper first if it's open
        if (cachedElements.kaartWrapper.classList.contains('visible')) {
            cachedElements.kaartWrapper.classList.remove('visible');
        }
        // Open text tree wrapper
        cachedElements.tekstueelWrapper.classList.add('visible');
    });
});

let map_oat;
let brk_oat;
let currentGeoJsonLayer;

async function showMap(perceelID, type) {
    try {
        const query = strSPARQLb(perceelID);
        const response = await executeSPARQL(query, SPARQLendpointB);
        const data = JSON.parse(response);

        if (!data.results.bindings[0]) {
            console.error('No geometry data found for perceel:', perceelID);
            return;
        }

        const value = data.results.bindings[0].wkt.value;
        const wkt = new Wkt.Wkt();

        let feature;
        try {
            wkt.read(value);
            feature = { "type": "Feature", "geometry": wkt.toJson() };
        } catch (e) {
            console.error('Error parsing WKT:', e);
            return;
        }

        // Remove existing maps if they exist
        if (map_oat) {
            try {
                map_oat.remove();
                map_oat = null;
            } catch (e) {
                console.error('Error removing map_oat:', e);
            }
        }
        if (brk_oat) {
            try {
                brk_oat.remove();
                brk_oat = null;
            } catch (e) {
                console.error('Error removing brk_oat:', e);
            }
        }

        // Create map based on type (reduce code duplication)
        const mapConfig = {
            fullscreenControl: true,
            fullscreenControlOptions: { position: 'topleft' }
        };
        const geoStyle = { color: '#d02828', fillColor: '#d02828', fillOpacity: 0.4 };

        const currentMap = L.map('kaart', mapConfig).setView([52.01, 4.71], 13);

        if (type === "OAT") {
            huc_knaw_hisgis.addTo(currentMap);
            map_oat = currentMap;
        } else {
            pdok_percelen_BRK.addTo(currentMap);
            brk_oat = currentMap;
        }

        // Add GeoJSON layer and fit bounds (reuse the layer)
        const geoJsonLayer = L.geoJSON(feature, { style: geoStyle });
        geoJsonLayer.addTo(currentMap);
        currentMap.fitBounds(geoJsonLayer.getBounds(), { maxZoom: 19 });
        currentGeoJsonLayer = geoJsonLayer;

        // Slide in the map wrapper
        cachedElements.kaartWrapper.classList.add('visible');

    } catch (error) {
        console.error('Error loading map:', error);
    }
}


async function bouwBoom(startUri, richting, root) {
    try {
        document.getElementById(`start-${richting}`).textContent = perceelDeel(startUri);

        const query = `
            PREFIX gtm: <https://www.goudatijdmachine.nl/def#>
            SELECT DISTINCT ?bron ?doel WHERE {
                VALUES ?start { <${startUri}> }
                ?start gtm:${richting}* ?bron .
                ?bron gtm:${richting} ?doel .
            }
        `;

        const response = await fetch(`${SPARQLendpointA}?query=${encodeURIComponent(query)}`, {
            headers: { 'Accept': 'application/sparql-results+json' }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const json = await response.json();
        const bindings = json.results.bindings;

        // Bouw een map van relaties: bron -> [doelen]
        const relaties = {};
        bindings.forEach(b => {
            const bron = b.bron.value;
            const doel = b.doel.value;
            if (!relaties[bron]) relaties[bron] = [];
            relaties[bron].push(doel);
        });

        const tekstueel = document.getElementById(`${richting}-tekstueel`);
        tekstueel.style.display = bindings.length > 0 ? "block" : "none";

        const container = document.getElementById(root);
        container.innerHTML = ''; // Maak leeg
        container.appendChild(renderNode(startUri, relaties));
    } catch (err) {
        console.error(`Data ophalen mislukt voor ${richting}:`, err);
        // Hide the section if there's an error
        const tekstueel = document.getElementById(`${richting}-tekstueel`);
        if (tekstueel) {
            tekstueel.style.display = "none";
        }
    }
}

function perceelDeel(uri){
    const parts = uri.split('/');
    return parts.slice(-2).join('-');
}

function renderNode(uri, relaties) {
    const li = document.createElement('li');
    const kinderen = relaties[uri] || [];

    const label = perceelDeel(uri);

    if (kinderen.length > 0) {
        // Node met kinderen: gebruik details/summary
        const details = document.createElement('details');
        details.open = true; // Standaard open

        const summary = document.createElement('summary');
        summary.textContent = label;
        details.appendChild(summary);

        const ul = document.createElement('ul');
        kinderen.forEach(kindUri => {
            ul.appendChild(renderNode(kindUri, relaties));
        });
        details.appendChild(ul);
        li.appendChild(details);
    } else {
        // Leaf node: gewoon tekst
        li.textContent = label;
    }

    return li;
}

async function toonFiliatie(start) {
    // Run both queries in parallel for better performance
    await Promise.all([
        bouwBoom(start, "opgegaanIn", "opgegaanin-root"),
        bouwBoom(start, "voortgekomenUit", "voortgekomen-root")
    ]);
}
