// willhaben results gallery — an MCP App rendered by capable hosts (Claude,
// Claude Desktop, VS Code, ...) inside a sandboxed iframe in the conversation.
//
// Receives the tool's structuredContent (see src/schemas.ts), renders search
// results as a card gallery (or one listing as a detail view), opens listings
// via the host, and paginates by re-calling the originating tool through the
// host with the echoed `query` args.
//
// Built into a single self-contained HTML file by scripts/build-ui.mjs.
// All data is untrusted: the DOM is built exclusively with textContent.

import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";

// Version kept in sync with package.json and src/server.ts.
const app = new App({ name: "willhaben-results", version: "1.1.0" });

const root = () => document.getElementById("root");

let state = {
  payload: null, // last structuredContent
  loadingMore: false,
};

// ---------------------------------------------------------------------------
// Small DOM helpers (no innerHTML for data — everything is textContent-safe)
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function attr(listing, name) {
  const value = listing.attributes ? listing.attributes[name] : undefined;
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

const FUEL_NAMES = { 100001: "Petrol", 100002: "Hybrid (petrol)", 100003: "Diesel", 100004: "Electric", 100005: "Hybrid (diesel)", 100006: "Gas" };
const TRANSMISSION_NAMES = { 180001: "Manual", 180004: "Automatic" };

function chipsFor(listing) {
  const chips = [];
  const area = attr(listing, "ESTATE_SIZE/LIVING_AREA");
  if (area) chips.push(area + " m²");
  const rooms = attr(listing, "NUMBER_OF_ROOMS");
  if (rooms) chips.push(rooms + " rooms");
  const ppm2 = attr(listing, "PRICE/SQUARE_METER_FOR_DISPLAY");
  if (ppm2) chips.push(ppm2);
  else if (listing.price_number && area) {
    const perM2 = listing.price_number / parseFloat(String(area).replace(",", "."));
    if (isFinite(perM2) && perM2 > 0) chips.push("€ " + Math.round(perM2).toLocaleString("de-AT") + " /m²");
  }
  const year = attr(listing, "YEAR_MODEL_FROM/TO");
  if (year) chips.push(String(year));
  const mileage = attr(listing, "MILEAGE");
  if (mileage) chips.push(Number(mileage) ? Number(mileage).toLocaleString("de-AT") + " km" : mileage + " km");
  const fuel = attr(listing, "ENGINE/FUEL");
  if (fuel) chips.push(FUEL_NAMES[fuel] || fuel);
  const trans = attr(listing, "TRANSMISSION");
  if (trans) chips.push(TRANSMISSION_NAMES[trans] || trans);
  const employment = attr(listing, "EMPLOYMENT_TYPE");
  if (employment) chips.push(employment);
  return chips.slice(0, 4);
}

const ALLOWED_LISTING_HOSTS = new Set(["www.willhaben.at", "willhaben.at"]);
const ALLOWED_IMAGE_HOSTS = new Set(["cache.willhaben.at", "www.willhaben.at", "willhaben.at"]);
const PAGINATION_TOOLS = new Set([
  "willhaben_search",
  "willhaben_search_real_estate",
  "willhaben_search_cars",
  "willhaben_search_jobs",
  "willhaben_search_marketplace",
]);

function httpsHostAllowed(url, hosts) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && hosts.has(parsed.hostname);
  } catch {
    return false;
  }
}

function openListing(url) {
  if (!httpsHostAllowed(url, ALLOWED_LISTING_HOSTS)) return;
  app.openLink({ url }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  const container = root();
  clear(container);
  const payload = state.payload;

  if (!payload) {
    const empty = el("div", "wh-empty", "Waiting for willhaben results…");
    container.appendChild(empty);
    return;
  }

  if (payload.listing) {
    container.appendChild(renderDetail(payload.listing));
    return;
  }

  container.appendChild(renderGallery(payload));
}

function renderHeader(payload) {
  const header = el("header", "wh-header");
  const title = el("div", "wh-title", payload.description || "willhaben results");
  const meta = el("div", "wh-meta");
  const shown = (payload.listings || []).length;
  const totalText =
    typeof payload.total === "number" ? payload.total.toLocaleString("de-AT") + " matches · showing " + shown : String(shown);
  meta.appendChild(el("span", "", totalText));
  if (payload.ranked_by && payload.ranked_by !== "none") meta.appendChild(el("span", "wh-badge", "ranked: " + payload.ranked_by));
  header.appendChild(title);
  header.appendChild(meta);
  if (payload.location_note) header.appendChild(el("div", "wh-note", payload.location_note));
  return header;
}

function renderCard(listing, detailIds) {
  const card = el("article", "wh-card");
  card.tabIndex = 0;
  // Accessible interactive control: announce as a link with a meaningful name.
  card.setAttribute("role", "link");
  const labelParts = [listing.title || "(untitled)", listing.price, listing.location].filter(Boolean);
  card.setAttribute("aria-label", labelParts.join(", ") + " — opens the listing on willhaben.at");

  const imageWrap = el("div", "wh-card-image");
  if (httpsHostAllowed(listing.image_url, ALLOWED_IMAGE_HOSTS)) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    img.src = listing.image_url;
    img.onerror = () => {
      imageWrap.removeChild(img);
      imageWrap.appendChild(el("div", "wh-card-image-placeholder", "📷"));
    };
    imageWrap.appendChild(img);
  } else {
    imageWrap.appendChild(el("div", "wh-card-image-placeholder", "📷"));
  }
  card.appendChild(imageWrap);

  const body = el("div", "wh-card-body");
  const topline = el("div", "wh-card-topline");
  topline.appendChild(el("span", "wh-price", listing.price || "—"));
  topline.appendChild(el("span", "wh-badge " + (listing.is_private ? "wh-badge-private" : "wh-badge-dealer"), listing.is_private ? "Private" : "Dealer"));
  body.appendChild(topline);

  body.appendChild(el("h3", "wh-card-title", listing.title || "(untitled)"));

  if (listing.location) body.appendChild(el("div", "wh-location", "📍 " + listing.location));

  const chips = el("div", "wh-chips");
  for (const chip of chipsFor(listing)) chips.appendChild(el("span", "wh-chip", chip));
  if (detailIds && detailIds.has(listing.id)) chips.appendChild(el("span", "wh-chip wh-chip-detail", "details ✓"));
  if (chips.childNodes.length) body.appendChild(chips);

  card.appendChild(body);

  const open = () => openListing(listing.url);
  card.addEventListener("click", open);
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });
  return card;
}

function renderGallery(payload) {
  const wrap = el("div", "wh-wrap");
  wrap.appendChild(renderHeader(payload));

  const listings = payload.listings || [];
  const detailIds = new Set((payload.details || []).map((d) => d.id));

  if (!listings.length) {
    wrap.appendChild(el("div", "wh-empty", "No listings found. Try loosening a filter."));
    return wrap;
  }

  const grid = el("div", "wh-grid");
  for (const listing of listings) grid.appendChild(renderCard(listing, detailIds));
  wrap.appendChild(grid);

  // Pagination via the echoed query (allowlisted search tools only).
  const query = payload.query;
  const canPaginate =
    query &&
    PAGINATION_TOOLS.has(query.tool) &&
    typeof payload.total === "number" &&
    listings.length < payload.total;

  if (canPaginate) {
    const button = el("button", "wh-more", state.loadingMore ? "Loading…" : "Load more results");
    button.disabled = state.loadingMore;
    button.addEventListener("click", async () => {
      if (state.loadingMore) return;
      if (!PAGINATION_TOOLS.has(query.tool)) return;
      state.loadingMore = true;
      render();
      try {
        const nextPage = (payload.page || 1) + 1;
        const result = await app.callServerTool({
          name: query.tool,
          arguments: Object.assign({}, query.args, { page: nextPage }),
        });
        const next = result && result.structuredContent;
        if (next && Array.isArray(next.listings)) {
          const seen = new Set(listings.map((l) => l.id));
          const merged = listings.concat(next.listings.filter((l) => !seen.has(l.id)));
          state.payload = Object.assign({}, payload, { listings: merged, page: next.page || nextPage });
        }
      } catch (e) {
        // leave current state; surface nothing scarier than the console
        console.error("load more failed", e);
      } finally {
        state.loadingMore = false;
        render();
      }
    });
    wrap.appendChild(button);
  }

  return wrap;
}

// Display-only excerpt for the detail card. The *security* bound on advert prose
// is MAX_BODY_CHARS in src/utils/formatters.ts, applied server-side before this
// text ever reaches the iframe -- this number only decides how much of an already
// sanitised description a card shows before it gets unwieldy. Do not mistake it
// for a safety limit, and keep it above the longest bodies seen live (~2k chars)
// so real listings are shown whole.
const DESCRIPTION_EXCERPT_CHARS = 2400;

const DETAIL_ATTR_LABELS = [
  ["ESTATE_SIZE/LIVING_AREA", "Living area", " m²"],
  ["NUMBER_OF_ROOMS", "Rooms", ""],
  ["PRICE/SQUARE_METER_FOR_DISPLAY", "Price/m²", ""],
  ["PROPERTY_TYPE", "Property type", ""],
  ["HEATING", "Heating", ""],
  ["ENERGY_HWB_CLASS", "Energy class (HWB)", ""],
  ["YEAR_MODEL_FROM/TO", "Year", ""],
  ["MILEAGE", "Mileage", " km"],
  ["ENGINE/FUEL", "Fuel", ""],
  ["TRANSMISSION", "Transmission", ""],
  ["CAR_MODEL/MAKE", "Make", ""],
  ["CAR_MODEL/MODEL", "Model", ""],
];

function renderDetail(listing) {
  const wrap = el("div", "wh-wrap");

  const header = el("header", "wh-header");
  header.appendChild(el("div", "wh-title", listing.title || "(untitled)"));
  const meta = el("div", "wh-meta");
  meta.appendChild(el("span", "wh-price", listing.price || "—"));
  meta.appendChild(el("span", "wh-badge " + (listing.is_private ? "wh-badge-private" : "wh-badge-dealer"), listing.is_private ? "Private" : "Dealer"));
  if (listing.location) meta.appendChild(el("span", "", "📍 " + listing.location));
  header.appendChild(meta);
  wrap.appendChild(header);

  const rawImages = listing.images || [];
  const images = rawImages.filter((src) => httpsHostAllowed(src, ALLOWED_IMAGE_HOSTS));
  if (images.length) {
    const gallery = el("div", "wh-detail-gallery");
    const hero = document.createElement("img");
    hero.className = "wh-hero";
    hero.alt = "";
    hero.src = images[0];
    gallery.appendChild(hero);
    if (images.length > 1) {
      const thumbs = el("div", "wh-thumbs");
      images.slice(0, 8).forEach((src) => {
        const t = document.createElement("img");
        t.className = "wh-thumb";
        t.loading = "lazy";
        t.alt = "";
        t.src = src;
        t.addEventListener("click", () => {
          if (httpsHostAllowed(src, ALLOWED_IMAGE_HOSTS)) hero.src = src;
        });
        thumbs.appendChild(t);
      });
      gallery.appendChild(thumbs);
    }
    wrap.appendChild(gallery);
  } else if (rawImages.length) {
    wrap.appendChild(el("div", "wh-card-image-placeholder", "📷"));
  }

  const facts = el("dl", "wh-facts");
  for (const [key, label, suffix] of DETAIL_ATTR_LABELS) {
    const raw = listing.attributes ? listing.attributes[key] : undefined;
    if (raw === undefined || raw === null) continue;
    let value = Array.isArray(raw) ? raw.join(", ") : raw;
    if (key === "ENGINE/FUEL") value = FUEL_NAMES[value] || value;
    if (key === "TRANSMISSION") value = TRANSMISSION_NAMES[value] || value;
    facts.appendChild(el("dt", "", label));
    facts.appendChild(el("dd", "", value + suffix));
  }
  if (facts.childNodes.length) wrap.appendChild(facts);

  const seller = listing.advertiser && listing.advertiser.name;
  const addressCity = listing.address && listing.address.city;
  if (seller || addressCity) {
    const box = el("div", "wh-seller");
    if (seller) box.appendChild(el("div", "", "👤 " + seller));
    if (addressCity) {
      const parts = [listing.address.street, listing.address.postcode, listing.address.city].filter(Boolean).join(", ");
      box.appendChild(el("div", "", "🏠 " + parts));
    }
    wrap.appendChild(box);
  }

  if (listing.description) {
    const desc = el("p", "wh-description");
    desc.textContent =
      listing.description.length > DESCRIPTION_EXCERPT_CHARS
        ? listing.description.slice(0, DESCRIPTION_EXCERPT_CHARS) + "…"
        : listing.description;
    wrap.appendChild(desc);
  }

  const open = el("button", "wh-more", "Open on willhaben.at ↗");
  open.addEventListener("click", () => openListing(listing.url));
  wrap.appendChild(open);

  return wrap;
}

// ---------------------------------------------------------------------------
// Host wiring
// ---------------------------------------------------------------------------

function applyTheme() {
  try {
    const ctx = app.getHostContext();
    const theme = ctx && ctx.theme;
    if (theme === "dark" || theme === "light") {
      document.documentElement.dataset.theme = theme;
    }
  } catch {
    /* prefers-color-scheme fallback in CSS */
  }
}

app.ontoolresult = (params) => {
  const structured = params && params.structuredContent;
  if (structured && typeof structured === "object") {
    state.payload = structured;
    state.loadingMore = false;
    render();
  }
};

app.onhostcontextchanged = () => {
  applyTheme();
};

(async () => {
  try {
    await app.connect();
  } catch (e) {
    console.error("app connect failed", e);
  }
  applyTheme();
  render();
})();
