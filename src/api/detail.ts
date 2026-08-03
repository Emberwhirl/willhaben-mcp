// Willhaben Ad Detail API - Get full listing details
import { WillhabenAdDetail, SimplifiedListingDetail } from "./types.js";
import { scrapeAdDetail } from "./scraper.js";
import { attributesToMap, stripRedundantAttributes } from "./search.js";
import { VERTICAL_NAMES } from "../utils/constants.js";

/**
 * Get full details for a specific listing by ad ID.
 *
 * Willhaben redirects `/iad/object?adId={id}` to the canonical detail page and
 * embeds the full ad as `advertDetails` in __NEXT_DATA__, so a single scrape
 * yields everything. (The publicapi `/atdetail/v1/{id}` endpoint returns a
 * widget-based payload that requires an application token, so it is not used.)
 */
export async function getListingDetail(id: string): Promise<SimplifiedListingDetail | null> {
  const adDetail = await scrapeAdDetail(`/iad/object?adId=${id}`);
  return adDetail ? simplifyAdDetail(adDetail) : null;
}

/**
 * Get listing detail by SEO URL (more reliable than ID-only)
 */
export async function getListingDetailBySeoUrl(seoUrl: string): Promise<SimplifiedListingDetail | null> {
  // Ensure URL starts with /iad/
  const urlPath = seoUrl.startsWith("/") ? seoUrl : `/iad/${seoUrl}`;
  const adDetail = await scrapeAdDetail(urlPath);

  if (!adDetail) {
    return null;
  }

  return simplifyAdDetail(adDetail);
}

/**
 * Simplify an ad detail into a clean, readable format
 */
function simplifyAdDetail(ad: WillhabenAdDetail): SimplifiedListingDetail {
  const attrs = attributesToMap(ad.attributes?.attribute);

  const images = (ad.advertImageList?.advertImage ?? [])
    .map((img) => img.referenceImageUrl ?? img.mainImageUrl)
    .filter((u): u is string => typeof u === "string" && u.length > 0);

  const seoUrl = attrs.SEO_URL as string | undefined;
  const url = seoUrl
    ? `https://www.willhaben.at/iad/${seoUrl}`
    : `https://www.willhaben.at/iad/object?adId=${ad.id}`;

  const priceForDisplay = attrs.PRICE_FOR_DISPLAY as string | undefined;
  const priceNumber = attrs.PRICE as string | undefined;
  const location = attrs.LOCATION as string | undefined;
  const heading = attrs.HEADING as string | undefined;
  const bodyDyn = attrs.BODY_DYN as string | undefined;
  const description = bodyDyn ?? ad.description ?? "";

  const parsedPrice = priceNumber ? parseFloat(priceNumber) : NaN;

  return {
    id: ad.id,
    title: heading ?? description.substring(0, 100),
    description,
    price: priceForDisplay ?? null,
    price_number: Number.isFinite(parsedPrice) ? parsedPrice : null,
    location: location ?? null,
    url,
    images,
    attributes: stripRedundantAttributes(attrs),
    vertical: VERTICAL_NAMES[ad.verticalId] ?? String(ad.verticalId),
    is_private: attrs.ISPRIVATE === "1",
    advertiser: {
      name: ad.organisationDetails?.orgName ?? null,
      phone: ad.organisationDetails?.orgPhone ?? null,
      email: ad.organisationDetails?.orgEmail ?? null,
      logo_url: ad.organisationDetails?.orgLogoUrl ?? null,
      active_ad_count: ad.sellerProfileUserData?.activeAdCount ?? null,
    },
    address: {
      street: ad.advertAddressDetails?.addressLines?.[0] ?? null,
      postcode: ad.advertAddressDetails?.postCode ?? null,
      city: ad.advertAddressDetails?.postalName ?? ad.advertAddressDetails?.municipality ?? null,
      country: ad.advertAddressDetails?.country ?? null,
      coordinates: attrs.COORDINATES
        ? Array.isArray(attrs.COORDINATES)
          ? attrs.COORDINATES.join(",")
          : attrs.COORDINATES
        : null,
    },
    contact_type: ad.contactOption?.contactType ?? null,
    chat_enabled: ad.chatEnabled ?? false,
    published_date: ad.publishedDate ?? null,
    category_id: ad.categoryTreeId ?? null,
  };
}