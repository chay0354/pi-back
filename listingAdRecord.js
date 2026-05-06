'use strict';

/**
 * Maps POST/PUT /api/listings JSON body to a row for `ads` (same fields as historical POST).
 */
async function buildAdRecordFromListingBody(body, supabase) {
  const {
    category,
    status = 'draft',
    subscriptionId,
    subscriptionType,
    propertyType,
    area,
    rooms,
    floor,
    purpose,
    price,
    projectName,
    address,
    phone,
    description,
    displayOption,
    feed_display_priority: feedDisplayPriority,
    mainImageUrl,
    additionalImageUrls = [],
    videoUrl,
    hasVideo,
    amenities,
    condition,
    searchPurpose,
    preferredApartmentType,
    preferredGender,
    preferredAgeMin,
    preferredAgeMax,
    preferences,
    budget,
    pricePerNight,
    hospitalityNature,
    serviceFacility,
    accommodationOffers,
    cancellationPolicy,
    contactDetails,
    proposedLand,
    planApproval,
    landInMortgage,
    permit,
    agriculturalLand,
    landOwnership,
    landAddress,
    landParcel,
    landBlock,
    constructionStatus,
    saleAtPresale,
    generalDetails,
    bnbHostType,
    bnbBusinessLogoUrl,
    hotDeal,
    projectOffers,
    companyOffersLandSizes,
    salesImageUrl,
    profileImageUrl,
    overlay_x: overlayX,
    overlay_y: overlayY,
    exposure_level: exposureLevel,
    feedPost,
    feed_post: feedPostSnake,
  } = body || {};

  const additionalUrls = Array.isArray(additionalImageUrls) ? additionalImageUrls : [];
  const additionalImageUrlsJson = additionalUrls.filter(Boolean);

  const descTrim = String(description || '').trim();
  const descriptionMarksFeedPost =
    descTrim === 'פוסט' ||
    descTrim.toLowerCase() === 'post';

  const explicitFeedPost =
    feedPost === true ||
    feedPost === 'true' ||
    feedPost === 1 ||
    feedPostSnake === true ||
    feedPostSnake === 'true' ||
    feedPostSnake === 't' ||
    descriptionMarksFeedPost;

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const validSubscriptionId =
    subscriptionId && typeof subscriptionId === 'string' && uuidRegex.test(subscriptionId.trim())
      ? subscriptionId.trim()
      : null;

  let creatorName = null;
  let creatorEmail = null;
  if (validSubscriptionId) {
    try {
      const { data: sub } = await supabase
        .from('subscriptions')
        .select('id, email, name, contact_person_name, subscription_type, business_name, broker_office_name')
        .eq('id', validSubscriptionId)
        .maybeSingle();
      if (sub) {
        creatorEmail = sub.email || null;
        const type = (sub.subscription_type || '').toLowerCase();
        if (type === 'company') {
          creatorName = sub.business_name || sub.name || sub.contact_person_name || null;
        } else if (type === 'broker') {
          creatorName = sub.broker_office_name || sub.name || sub.contact_person_name || null;
        } else {
          creatorName = sub.name || sub.business_name || sub.contact_person_name || null;
        }
      }
    } catch (_) {
      /* ignore */
    }
  }

  const adRecord = {
    subscription_id: validSubscriptionId,
    owner_id: subscriptionId && typeof subscriptionId === 'string' && subscriptionId.trim() ? subscriptionId.trim() : null,
    creator_name: creatorName,
    creator_email: creatorEmail,
    subscription_type: subscriptionType || null,
    category: category != null ? parseInt(category, 10) : 1,
    status: status === 'published' ? 'published' : 'draft',
    main_image_url: mainImageUrl || null,
    additional_image_urls: additionalImageUrlsJson.length ? additionalImageUrlsJson : [],
    video_url: videoUrl || null,
    sales_image_url: salesImageUrl || null,
    profile_image_url: profileImageUrl || null,
    bnb_business_logo_url:
      typeof bnbBusinessLogoUrl === 'string' && bnbBusinessLogoUrl.trim() !== ''
        ? bnbBusinessLogoUrl.trim()
        : null,
    display_option: displayOption || null,
    feed_display_priority:
      feedDisplayPriority === 'mainImage'
        ? 'mainImage'
        : feedDisplayPriority === 'video'
          ? 'video'
          : null,
    property_type:
      (propertyType != null && String(propertyType).trim() !== ''
        ? String(propertyType).trim()
        : null) ||
      (explicitFeedPost ? 'post' : null),
    area: area != null ? parseInt(area, 10) : null,
    rooms: rooms != null ? parseInt(rooms, 10) : null,
    floor: floor != null ? parseInt(floor, 10) : null,
    purpose: purpose || 'sale',
    price: price != null ? parseFloat(price) : null,
    budget: budget != null ? parseFloat(budget) : null,
    price_per_night: pricePerNight != null ? parseFloat(pricePerNight) : null,
    amenities: amenities && typeof amenities === 'object' ? amenities : null,
    condition: condition || null,
    project_name: projectName != null && String(projectName).trim() !== '' ? String(projectName).trim() : null,
    address: address || null,
    phone: phone || null,
    description: description || null,
    feed_post: Boolean(explicitFeedPost),
    overlay_x: overlayX != null ? parseInt(overlayX, 10) : null,
    overlay_y: overlayY != null ? parseInt(overlayY, 10) : null,
    search_purpose: searchPurpose || null,
    preferred_apartment_type: preferredApartmentType || null,
    preferred_gender: preferredGender || null,
    preferred_age_min: preferredAgeMin != null ? parseInt(preferredAgeMin, 10) : null,
    preferred_age_max: preferredAgeMax != null ? parseInt(preferredAgeMax, 10) : null,
    preferences: preferences && typeof preferences === 'object' ? preferences : null,
    hospitality_nature: hospitalityNature || null,
    service_facility: serviceFacility && typeof serviceFacility === 'object' ? serviceFacility : null,
    accommodation_offers: accommodationOffers && typeof accommodationOffers === 'object' ? accommodationOffers : null,
    cancellation_policy: cancellationPolicy || null,
    hot_deal: !!(
      hotDeal === true ||
      hotDeal === 'true' ||
      hotDeal === 1 ||
      hotDeal === '1'
    ),
    contact_details: contactDetails && typeof contactDetails === 'object' ? contactDetails : null,
    proposed_land: proposedLand && typeof proposedLand === 'object' ? proposedLand : null,
    plan_approval: planApproval || null,
    land_in_mortgage: landInMortgage || null,
    permit: permit || null,
    agricultural_land: agriculturalLand || null,
    land_ownership: landOwnership || null,
    land_address: (() => {
      const line =
        landAddress != null && String(landAddress).trim() !== '' ? String(landAddress).trim() : null;
      const parcelStr =
        landParcel != null && String(landParcel).trim() !== '' ? String(landParcel).trim() : null;
      const blockStr =
        landBlock != null && String(landBlock).trim() !== '' ? String(landBlock).trim() : null;
      const parts = [
        line,
        parcelStr ? `חלקה ${parcelStr}` : null,
        blockStr ? `גוש ${blockStr}` : null,
      ].filter(Boolean);
      return parts.length ? parts.join(' | ') : null;
    })(),
    construction_status: constructionStatus || null,
    sale_at_presale:
      saleAtPresale !== undefined && saleAtPresale !== null
        ? saleAtPresale === true || saleAtPresale === 'true'
        : null,
    general_details: (() => {
      const base =
        generalDetails && typeof generalDetails === 'object' ? {...generalDetails} : {};
      const bnb =
        bnbHostType === 'private' || bnbHostType === 'business' ? String(bnbHostType) : null;
      if (bnb) base.bnb_host_type = bnb;
      return Object.keys(base).length ? base : null;
    })(),
    project_offers: projectOffers && typeof projectOffers === 'object' ? projectOffers : null,
    company_offers_land_sizes:
      companyOffersLandSizes && typeof companyOffersLandSizes === 'object'
        ? companyOffersLandSizes
        : null,
    exposure_level: ['low', 'medium', 'high'].includes(String(exposureLevel || '').toLowerCase())
      ? String(exposureLevel).toLowerCase()
      : 'medium',
  };

  return adRecord;
}

module.exports = { buildAdRecordFromListingBody };
