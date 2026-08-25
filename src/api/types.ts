// Willhaben API Types

// Vertical IDs
export const VerticalId = {
  JOBS: 1,
  IMMOBILIEN: 2,
  AUTO_MOTOR: 3,
  MARKTPLATZ: 5,
} as const;

export type VerticalIdType = (typeof VerticalId)[keyof typeof VerticalId];

// Search result from __NEXT_DATA__
export interface WillhabenSearchResult {
  id: number;
  description: string;
  heading: string;
  verticalId: number;
  searchId: number;
  rowsRequested: number;
  rowsFound: number;
  rowsReturned: number;
  pageRequested: number;
  searchDate: string;
  lastUserAlertViewedDate: string | null;
  newAdsSeparatorPosition: number | null;
  advertSummaryList: {
    advertSummary: WillhabenAdSummary[];
  };
  breadcrumbs: WillhabenBreadcrumb[];
  navigatorGroups: WillhabenNavigatorGroup[];
  searchExcludeList: unknown;
  pagingLinksList: {
    contextLink: WillhabenContextLink[];
  };
  sortOrderList: {
    contextLink: WillhabenSortOption[];
  };
  searchContextLinks: {
    contextLink: WillhabenContextLink[];
  };
  taggingData: unknown;
  seoMetaData: WillhabenSeoMetaData;
  autocompleteLinkList: unknown;
  searchTitle: string;
  searchSubTitle: string;
  advertisingParameters: unknown;
  advertisingParametersV2: unknown;
  dmpParameters: unknown;
  dmpUserIdentities: unknown;
  metaData: {
    viewMode: string;
    defaultPageSize: number;
  };
  statistics: unknown;
  brazeBanners: unknown;
}

export interface WillhabenAdSummary {
  id: string;
  verticalId: number;
  adTypeId: number;
  productId: number;
  advertStatus: {
    id: string;
    description: string;
    statusId: number;
  };
  description: string;
  attributes: {
    attribute: WillhabenAttribute[];
  };
  advertImageList: {
    advertImage: WillhabenAdImage[];
  };
  selfLink: string;
  contextLinkList: {
    contextLink: WillhabenContextLink[];
  };
  advertiserInfo: {
    label: string;
    iconType: string;
  };
  upsellingOrganisationLogo: string | null;
  teaserAttributes: WillhabenTeaserAttribute[];
  children: unknown;
  dmpParameters: unknown;
  saved?: boolean;
}

export interface WillhabenAttribute {
  name: string;
  values: string[];
}

export interface WillhabenAdImage {
  id: number;
  name: string;
  selfLink: string;
  description: string;
  mainImageUrl: string;
  thumbnailImageUrl: string;
  referenceImageUrl: string;
  similarImageSearchUrl: string | null;
  reference: string;
}

export interface WillhabenContextLink {
  id: string;
  description: string;
  uri: string;
  selected: boolean;
  relativePath: string;
  serviceName: string;
}

export interface WillhabenSortOption {
  id: string;
  description: string;
  uri: string;
  selected: boolean;
  relativePath: string;
  serviceName: string;
}

export interface WillhabenBreadcrumb {
  displayName: string;
  seoUrl: string;
}

export interface WillhabenSeoMetaData {
  canonicalUrl: string;
  alternateUrl: string;
  title: string;
  keywords: string;
  description: string;
  orgId: string | null;
}

export interface WillhabenTeaserAttribute {
  prefix: string | null;
  value: string;
  postfix: string;
}

export interface WillhabenNavigatorGroup {
  label: string;
  navigatorList: WillhabenNavigator[];
}

export interface WillhabenNavigator {
  id: string;
  label: string;
  type: string;
  possibleValues: WillhabenNavigatorValue[];
  groupedPossibleValues: WillhabenGroupedNavigatorValue[];
  searchLink: WillhabenContextLink;
}

export interface WillhabenNavigatorValue {
  label: string;
  prePostTextInfo: string | null;
  images: unknown[];
  urlParamRepresentationForValue: {
    urlParameterName: string;
    navigatorUrlParameterType: string;
    value: string;
  }[];
  parent: string | null;
  parentId: string | null;
  parentLabel: string | null;
  count?: number;
}

export interface WillhabenGroupedNavigatorValue {
  label: string | null;
  possibleValues: WillhabenNavigatorValue[];
}

// Ad Detail from __NEXT_DATA__
export interface WillhabenAdDetail {
  id: string;
  uuid: string;
  verticalId: number;
  adTypeId: number;
  productId: number;
  parentAdId: string | null;
  description: string;
  startDate: string;
  endDate: string | null;
  publishedDate: string;
  firstPublishedDate: string;
  createdDate: string;
  changedDate: string;
  advertiserReferenceNumber: string | null;
  attributes: {
    attribute: WillhabenAttribute[];
  };
  advertImageList: {
    advertImage: WillhabenAdImage[];
    floorPlans: unknown[];
  };
  advertAttachmentList: unknown;
  organisationDetails: WillhabenOrganisationDetails;
  sellerProfileUserData: WillhabenSellerProfile;
  advertAddressDetails: WillhabenAddressDetails;
  advertContactDetails: {
    contactDetail: WillhabenContactDetail[];
  };
  contextLinkList: {
    contextLink: WillhabenContextLink[];
  };
  taggingData: unknown;
  advertisingParameters: unknown;
  advertisingParametersV2: unknown;
  dmpParameters: unknown;
  dmpUserIdentities: unknown;
  advertStatus: {
    id: string;
    description: string;
    statusId: number;
  };
  advertEditStatusActionsList: unknown;
  seoMetaData: WillhabenSeoMetaData;
  premiumServiceBoxListResponseDto: unknown;
  categoryTreeId: number;
  attributeInformation: unknown;
  facebookTrackingData: unknown;
  savedInFolder: unknown;
  chatEnabled: boolean;
  loginUUid: string | null;
  tooltips: unknown;
  categoryXmlCode: string;
  ownageTypeXmlCode: string;
  contactOption: {
    contactType: string;
    additionalInfo: string | null;
  };
  breadcrumbs: WillhabenBreadcrumb[];
  inputSource: unknown;
  equipmentList: unknown;
  contactSuggestions: unknown;
  p2ppOptions: unknown;
  disposed: boolean;
  publishInfo: unknown;
  upsellings: unknown;
  deleteReason: unknown;
  teaserAttributes: WillhabenTeaserAttribute[];
  loginId: string | null;
}

export interface WillhabenOrganisationDetails {
  id: string;
  uuid: string;
  partnerId: string;
  description: string;
  organisationDetailLinkList: unknown;
  orgName: string;
  orgPhone: string;
  orgEmail: string;
  orgLogoUrl: string;
  addressLines: string[];
  postCode: string;
  country: string;
  countryId: string;
  openingHours: string | null;
}

export interface WillhabenSellerProfile {
  name: string;
  registerDate: string;
  location: string;
  street: string;
  district: string;
  orgUUID: string;
  pictureUrl: string;
  hasProfileImage: boolean;
  activeAdCount: number;
  private: boolean;
}

export interface WillhabenAddressDetails {
  addressLines: string[];
  postCode: string;
  postalName: string;
  country: string;
  province: string;
  district: string;
  municipality: string;
}

export interface WillhabenContactDetail {
  contactType: string;
  value: string;
}

// Jobs API types
export interface WillhabenJobsSearchResult {
  searchTitle: string;
  searchSubTitle: string;
  searchId: number;
  verticalId: number;
  rowsRequested: number;
  pageRequested: number;
  rowsFound: number;
  rowsReturned: number;
  searchDate: string;
  lastUserAlertViewedDate: string;
  advertSummaryList: WillhabenJobAd[];
  breadcrumbs: unknown;
  navigatorGroups: WillhabenNavigatorGroup[];
  pagingLinksList: {
    contextLink: WillhabenContextLink[];
  };
  sortOrderList: {
    contextLink: WillhabenSortOption[];
  };
  searchContextLinks: {
    contextLink: WillhabenContextLink[];
  };
  seoMetaData: WillhabenSeoMetaData;
  metaData: {
    viewMode: string;
    defaultPageSize: number;
  };
}

export interface WillhabenJobAd {
  id: string;
  verticalId: number;
  adTypeId: number;
  description: string;
  saved: boolean;
  attributes: WillhabenAttribute[];
  advertImageList: {
    mainImageUrl: string;
    referenceImageUrl: string;
    thumbnailImageUrl: string;
  };
  selfLink: string;
  contextLinkList: {
    contextLink: WillhabenContextLink[];
  };
  dmpParameters: unknown;
}

// MCP tool input types
export interface SearchInput {
  vertical: "marketplace" | "real_estate" | "cars" | "jobs";
  keyword?: string;
  category?: string;
  location?: string;
  /** Pre-resolved willhaben areaId; when set, `location` is not resolved again. */
  area_id?: string;
  price_from?: number;
  price_to?: number;
  sort?: string;
  rows?: number;
  page?: number;
}

export interface RealEstateSearchInput {
  keyword?: string;
  /** Explicit willhaben category path; when set, wins over property_type/action. */
  category?: string;
  property_type?: string;
  action?: "buy" | "rent";
  location?: string;
  /** Pre-resolved willhaben areaId; when set, `location` is not resolved again. */
  area_id?: string;
  price_from?: number;
  price_to?: number;
  rooms?: number;
  area_from?: number;
  area_to?: number;
  sort?: string;
  rows?: number;
  page?: number;
}

export interface CarSearchInput {
  keyword?: string;
  make?: string;
  model?: string;
  location?: string;
  /** Pre-resolved willhaben areaId; when set, `location` is not resolved again. */
  area_id?: string;
  price_from?: number;
  price_to?: number;
  year_from?: number;
  year_to?: number;
  mileage_from?: number;
  mileage_to?: number;
  fuel_type?: string;
  transmission?: string;
  condition?: string;
  sort?: string;
  rows?: number;
  page?: number;
}

// Simplified output types for MCP responses
export interface SimplifiedListing {
  id: string;
  title: string;
  price: string | null;
  price_number: number | null;
  location: string | null;
  url: string;
  image_url: string | null;
  published: string | null;
  attributes: Record<string, string | string[]>;
  vertical: string;
  is_private: boolean;
  advertiser_name: string | null;
}

export interface SimplifiedListingDetail {
  id: string;
  title: string;
  description: string;
  price: string | null;
  price_number: number | null;
  location: string | null;
  url: string;
  images: string[];
  attributes: Record<string, string | string[]>;
  vertical: string;
  is_private: boolean;
  advertiser: {
    name: string | null;
    phone: string | null;
    email: string | null;
    logo_url: string | null;
    active_ad_count: number | null;
  };
  address: {
    street: string | null;
    postcode: string | null;
    city: string | null;
    country: string | null;
    coordinates: string | null;
  };
  contact_type: string | null;
  chat_enabled: boolean;
  published_date: string | null;
  category_id: number | null;
}