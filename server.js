require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
let supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Check if service role key is set and not a placeholder
if (!supabaseKey || supabaseKey.includes('YOUR_SERVICE_ROLE_KEY_HERE')) {
  console.warn('⚠️  WARNING: SUPABASE_SERVICE_ROLE_KEY not set or is a placeholder.');
  console.warn('⚠️  Using anon key as fallback. Some operations may fail.');
  console.warn('⚠️  Please get your service_role key from Supabase Dashboard > Settings > API');
  supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize Resend for email sending (optional - can use other services)
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Configure multer for file uploads (in-memory storage)
const upload = multer({ storage: multer.memoryStorage() });

// Helper function to send verification email
const sendVerificationEmail = async (email, verificationCode, subscriptionType) => {
  const typeNames = {
    broker: 'מתווכים',
    company: 'חברות',
    professional: 'בעלי מקצוע'
  };
  
  const typeName = typeNames[subscriptionType] || 'מנוי';
  
  // Try Resend first (if configured)
  if (resend) {
    try {
      await resend.emails.send({
        from: process.env.EMAIL_FROM || 'onboarding@resend.dev', // Use Resend test domain if not configured
        to: email,
        subject: `קוד אימות - מנוי ${typeName}`,
        html: `
          <div dir="rtl" style="font-family: Arial, sans-serif; text-align: right;">
            <h2>שלום,</h2>
            <p>תודה על הרשמתך למנוי ${typeName}.</p>
            <p>קוד האימות שלך הוא:</p>
            <div style="background-color: #f0f0f0; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; margin: 20px 0; border-radius: 8px;">
              ${verificationCode}
            </div>
            <p>קוד זה תקף ל-15 דקות.</p>
            <p>אם לא ביקשת קוד זה, אנא התעלם מהמייל.</p>
            <p>בברכה,<br>צוות PI</p>
          </div>
        `,
      });
      console.log(`✅ Verification email sent to ${email} via Resend`);
      return true;
    } catch (error) {
      console.error('❌ Error sending email via Resend:', error);
      // Fall through to console log
    }
  }
  
  // Fallback: log to console (for development)
  console.log(`\n📧 === VERIFICATION EMAIL ===`);
  console.log(`To: ${email}`);
  console.log(`Subject: קוד אימות - מנוי ${typeName}`);
  console.log(`Code: ${verificationCode}`);
  console.log(`==========================\n`);
  return false;
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// ==================== SUBSCRIPTION ENDPOINTS ====================

// Submit subscription form (all types: broker, company, professional)
app.post('/api/subscription/submit', upload.fields([
  { name: 'profilePicture', maxCount: 1 },
  { name: 'additionalImages', maxCount: 10 },
  { name: 'companyLogo', maxCount: 1 },
  { name: 'video', maxCount: 1 }
]), async (req, res) => {
  try {
    const {
      subscriptionType, // 'broker', 'company', 'professional'
      email,
      phone,
      name,
      businessName,
      businessAddress,
      brokerageLicenseNumber, // For broker subscriptions
      brokerOfficeName, // For broker subscriptions
      agentName, // For broker subscriptions
      dealerNumber,
      companyId,
      contactPersonName,
      officePhone,
      mobilePhone,
      companyWebsite,
      description,
      types, // Array of selected types (for professional)
      specializations, // Array of selected specializations (for professional)
      activityRegions, // Array of selected regions (for broker)
      agreedToTerms
    } = req.body;

    // Validate required fields based on subscription type
    if (subscriptionType === 'company') {
      if (!businessName || !contactPersonName || !email || !officePhone) {
        return res.status(400).json({ 
          success: false, 
          error: 'Missing required fields for company subscription' 
        });
      }
    } else if (subscriptionType === 'broker') {
      // For broker: email, phone, name (agentName), brokerageLicenseNumber, brokerOfficeName are required
      if (!email || !phone || !name || !brokerageLicenseNumber || !brokerOfficeName) {
        return res.status(400).json({ 
          success: false, 
          error: 'Missing required fields for broker subscription. Please provide email, phone, agent name, brokerage license number, and broker office name.' 
        });
      }
    } else {
      // For professional: email, phone, and name (or businessName) are required
      if (!email || !phone || (!name && !businessName)) {
        return res.status(400).json({ 
          success: false, 
          error: 'Missing required fields. Please provide email, phone, and name/business name.' 
        });
      }
    }

    // Upload files to Supabase Storage
    const fileUrls = {};
    
    if (req.files) {
      // Upload profile picture
      if (req.files.profilePicture && req.files.profilePicture[0]) {
        const profileFile = req.files.profilePicture[0];
        const fileName = `profile-${Date.now()}-${profileFile.originalname}`;
        const { data, error } = await supabase.storage
          .from('user-pohto-video')
          .upload(`profiles/${fileName}`, profileFile.buffer, {
            contentType: profileFile.mimetype,
            upsert: false
          });
        
        if (!error && data) {
          const { data: urlData } = supabase.storage
            .from('user-pohto-video')
            .getPublicUrl(`profiles/${fileName}`);
          fileUrls.profilePicture = urlData.publicUrl;
        }
      }

      // Upload additional images
      if (req.files.additionalImages) {
        fileUrls.additionalImages = [];
        for (const file of req.files.additionalImages) {
          const fileName = `additional-${Date.now()}-${file.originalname}`;
          const { data, error } = await supabase.storage
            .from('user-pohto-video')
            .upload(`additional/${fileName}`, file.buffer, {
              contentType: file.mimetype,
              upsert: false
            });
          
          if (!error && data) {
            const { data: urlData } = supabase.storage
              .from('user-pohto-video')
              .getPublicUrl(`additional/${fileName}`);
            fileUrls.additionalImages.push(urlData.publicUrl);
          }
        }
      }

      // Upload company logo
      if (req.files.companyLogo && req.files.companyLogo[0]) {
        const logoFile = req.files.companyLogo[0];
        const fileName = `logo-${Date.now()}-${logoFile.originalname}`;
        const { data, error } = await supabase.storage
          .from('user-pohto-video')
          .upload(`logos/${fileName}`, logoFile.buffer, {
            contentType: logoFile.mimetype,
            upsert: false
          });
        
        if (!error && data) {
          const { data: urlData } = supabase.storage
            .from('user-pohto-video')
            .getPublicUrl(`logos/${fileName}`);
          fileUrls.companyLogo = urlData.publicUrl;
        }
      }

      // Upload video
      if (req.files.video && req.files.video[0]) {
        const videoFile = req.files.video[0];
        const fileName = `video-${Date.now()}-${videoFile.originalname}`;
        const { data, error } = await supabase.storage
          .from('user-pohto-video')
          .upload(`videos/${fileName}`, videoFile.buffer, {
            contentType: videoFile.mimetype,
            upsert: false
          });
        
        if (!error && data) {
          const { data: urlData } = supabase.storage
            .from('user-pohto-video')
            .getPublicUrl(`videos/${fileName}`);
          fileUrls.video = urlData.publicUrl;
        }
      }
    }

    // Generate verification code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Save subscription data to database
    // Ensure subscription_type is preserved correctly for all 3 flows: broker, company, professional
    const subscriptionData = {
      subscription_type: subscriptionType, // 'broker', 'company', or 'professional' - PRESERVED
      email,
      phone: phone || officePhone,
      name: name || agentName || businessName || contactPersonName, // Use name, agentName, businessName, or contactPersonName
      business_name: businessName || brokerOfficeName, // For broker: brokerOfficeName, for others: businessName
      business_address: businessAddress,
      brokerage_license_number: brokerageLicenseNumber || null, // For broker subscriptions
      broker_office_name: brokerOfficeName || null, // For broker subscriptions
      dealer_number: dealerNumber,
      company_id: companyId,
      contact_person_name: contactPersonName,
      office_phone: officePhone,
      mobile_phone: mobilePhone,
      company_website: companyWebsite,
      description,
      types: types ? (Array.isArray(types) ? JSON.stringify(types) : types) : null, // For professional
      specializations: specializations ? (Array.isArray(specializations) ? JSON.stringify(specializations) : specializations) : null, // For professional
      activity_regions: activityRegions ? (Array.isArray(activityRegions) ? JSON.stringify(activityRegions) : activityRegions) : null, // For broker
      profile_picture_url: fileUrls.profilePicture || null,
      additional_images_urls: fileUrls.additionalImages ? JSON.stringify(fileUrls.additionalImages) : null,
      company_logo_url: fileUrls.companyLogo || null,
      video_url: fileUrls.video || null,
      verification_code: verificationCode,
      verification_code_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 minutes from now (UTC)
      agreed_to_terms: agreedToTerms || false,
      status: 'pending_verification',
      created_at: new Date().toISOString()
    };

    const { data: subscription, error: dbError } = await supabase
      .from('subscriptions')
      .insert([subscriptionData])
      .select()
      .single();

    if (dbError) {
      console.error('Database error:', dbError);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to save subscription data',
        details: dbError.message 
      });
    }

    // Send verification email with code
    await sendVerificationEmail(email, verificationCode, subscriptionType);

    res.json({
      success: true,
      subscriptionId: subscription.id,
      verificationCode: verificationCode, // Remove in production
      message: 'Subscription submitted successfully. Please check your email for verification code.'
    });

  } catch (error) {
    console.error('Error submitting subscription:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Verify email with code
app.post('/api/subscription/verify', async (req, res) => {
  try {
    const { email, verificationCode, subscriptionId } = req.body;

    if (!verificationCode) {
      return res.status(400).json({ 
        success: false, 
        error: 'Verification code is required' 
      });
    }

    if (!email && !subscriptionId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email or subscription ID is required' 
      });
    }

    // Find subscription by ID (preferred) or email and verification code
    let query = supabase
      .from('subscriptions')
      .select('*');
    
    if (subscriptionId) {
      query = query.eq('id', subscriptionId);
    } else {
      query = query.eq('email', email);
    }
    
    query = query
      .eq('verification_code', verificationCode)
      .eq('status', 'pending_verification');
    
    const { data: subscription, error } = await query.single();

    if (error || !subscription) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid verification code' 
      });
    }

    // Check if code is expired
    if (!subscription.verification_code_expires_at) {
      console.warn('No expiration date found for subscription:', subscription.id);
      // If no expiration date, allow verification (for backward compatibility)
    } else {
      // Parse expiration date - handle timezone issues
      // Supabase TIMESTAMP columns store dates in UTC, but may return them without 'Z'
      let expiresAt;
      const rawExpiresAt = subscription.verification_code_expires_at;
      
      if (typeof rawExpiresAt === 'string') {
        // If it already has timezone info, parse directly
        if (rawExpiresAt.endsWith('Z') || rawExpiresAt.includes('+') || rawExpiresAt.match(/-\d{2}:\d{2}$/)) {
          expiresAt = new Date(rawExpiresAt);
        } else {
          // Date without timezone - Supabase stores TIMESTAMP as UTC, so append 'Z' to treat as UTC
          // Handle both formats: '2026-01-29T13:36:46.32' and '2026-01-29T13:36:46'
          const dateStr = rawExpiresAt.includes('.') ? rawExpiresAt : rawExpiresAt + '.000';
          expiresAt = new Date(dateStr + 'Z');
        }
      } else {
        expiresAt = new Date(rawExpiresAt);
      }
      
      // Validate the parsed date
      if (isNaN(expiresAt.getTime())) {
        console.error('Invalid expiration date:', rawExpiresAt);
        // If we can't parse it, allow verification (better UX than blocking)
        expiresAt = new Date(Date.now() + 15 * 60 * 1000); // Set to 15 min from now
      }
      
      const now = new Date();
      
      // Add logging for debugging
      const timeUntilExpiry = expiresAt - now;
      const minutesUntilExpiry = Math.round(timeUntilExpiry / 1000 / 60);
      
      console.log('Verification code expiration check:', {
        subscriptionId: subscription.id,
        email: subscription.email,
        expiresAt: expiresAt.toISOString(),
        now: now.toISOString(),
        expiresInMinutes: minutesUntilExpiry,
        isExpired: expiresAt < now,
        rawExpiresAt: rawExpiresAt,
        rawType: typeof rawExpiresAt
      });
      
      // Check if expired
      // Note: We check if expiresAt is less than now (code has expired)
      if (expiresAt < now) {
        console.warn('Code expired:', {
          expiresAt: expiresAt.toISOString(),
          now: now.toISOString(),
          differenceMinutes: minutesUntilExpiry
        });
        return res.status(400).json({ 
          success: false, 
          error: `Verification code has expired. Please request a new code. (Expired ${Math.abs(minutesUntilExpiry)} minutes ago)` 
        });
      }
    }

    // Generate unique subscriber number (9 digits)
    // Check for uniqueness to ensure it's a real, unique number
    let subscriberNumber;
    let isUnique = false;
    let attempts = 0;
    const maxAttempts = 10;
    
    while (!isUnique && attempts < maxAttempts) {
      subscriberNumber = Math.floor(100000000 + Math.random() * 900000000).toString();
      
      // Check if this number already exists
      const { data: existing } = await supabase
        .from('subscriptions')
        .select('id')
        .eq('subscriber_number', subscriberNumber)
        .single();
      
      if (!existing) {
        isUnique = true;
      }
      attempts++;
    }
    
    if (!isUnique) {
      // Fallback: use timestamp-based number if we can't find a unique random one
      subscriberNumber = (Date.now() % 900000000 + 100000000).toString();
      console.warn('Could not generate unique subscriber number, using timestamp-based:', subscriberNumber);
    }
    
    console.log('Generated subscriber number:', subscriberNumber);

    // Update subscription status
    const { data: updatedSubscription, error: updateError } = await supabase
      .from('subscriptions')
      .update({
        status: 'verified',
        subscriber_number: subscriberNumber,
        verified_at: new Date().toISOString()
      })
      .eq('id', subscription.id)
      .select()
      .single();

    if (updateError) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to verify subscription' 
      });
    }

    res.json({
      success: true,
      subscription: updatedSubscription,
      subscriberNumber: subscriberNumber,
      message: 'Email verified successfully'
    });

  } catch (error) {
    console.error('Error verifying subscription:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Resend verification code
app.post('/api/subscription/resend-code', async (req, res) => {
  try {
    const { email, subscriptionId } = req.body;

    if (!email && !subscriptionId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email or subscription ID is required' 
      });
    }

    // Find subscription by ID (preferred) or email
    let query = supabase
      .from('subscriptions')
      .select('*');
    
    if (subscriptionId) {
      query = query.eq('id', subscriptionId);
    } else {
      query = query.eq('email', email);
    }
    
    query = query.eq('status', 'pending_verification');
    
    const { data: subscription, error } = await query.single();

    if (error || !subscription) {
      console.error('Subscription lookup error:', error);
      console.error('Looking for:', { email, subscriptionId });
      return res.status(404).json({ 
        success: false, 
        error: 'Subscription not found. Please make sure you completed the form submission.' 
      });
    }

    // Generate new verification code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Update subscription with new code
    const { error: updateError } = await supabase
      .from('subscriptions')
      .update({
        verification_code: verificationCode,
        verification_code_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      })
      .eq('id', subscription.id);

    if (updateError) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to resend verification code' 
      });
    }

    // Send verification email
    await sendVerificationEmail(email, verificationCode, subscription.subscription_type);

    res.json({
      success: true,
      verificationCode: verificationCode, // Remove in production
      message: 'Verification code resent successfully'
    });

  } catch (error) {
    console.error('Error resending code:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get subscription by ID
app.get('/api/subscription/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !subscription) {
      return res.status(404).json({ 
        success: false, 
        error: 'Subscription not found' 
      });
    }

    res.json({
      success: true,
      subscription
    });

  } catch (error) {
    console.error('Error fetching subscription:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get current user subscription by email or subscriber number
app.get('/api/user/current', async (req, res) => {
  try {
    const { email, subscriberNumber } = req.query;

    if (!email && !subscriberNumber) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email or subscriber number is required' 
      });
    }

    let query = supabase
      .from('subscriptions')
      .select('*')
      .eq('status', 'verified'); // Only return verified subscriptions
    
    if (subscriberNumber) {
      query = query.eq('subscriber_number', subscriberNumber);
    } else {
      query = query.eq('email', email);
    }
    
    const { data: subscription, error } = await query.single();

    if (error || !subscription) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }

    res.json({
      success: true,
      subscription
    });

  } catch (error) {
    console.error('Error fetching current user:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ==================== LISTINGS ENDPOINTS ====================

// GET /api/listings - fetch published listings from unified ads table (optional filter by category)
// Media (images/video) are stored in bucket user-photo-video; URLs are in ads row.
app.get('/api/listings', async (req, res) => {
  try {
    const status = req.query.status || 'published';
    const category = req.query.category ? parseInt(req.query.category, 10) : null;

    let query = supabase
      .from('ads')
      .select('*')
      .eq('status', status)
      .order('created_at', { ascending: false });

    if (category && !isNaN(category)) {
      query = query.eq('category', category);
    }

    const { data: adsRows, error } = await query;

    if (error) {
      console.error('Error fetching listings:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch listings',
        details: error.message
      });
    }

    // Shape for frontend: add listing_images and listing_videos from unified media columns
    const listings = (adsRows || []).map((row) => {
      const listing_images = [];
      if (row.main_image_url) {
        listing_images.push({ image_url: row.main_image_url, image_type: 'main' });
      }
      const additional = Array.isArray(row.additional_image_urls) ? row.additional_image_urls : [];
      additional.forEach((url) => {
        if (url) listing_images.push({ image_url: url, image_type: 'additional' });
      });
      const listing_videos = row.video_url ? [{ video_url: row.video_url }] : [];
      return { ...row, listing_images, listing_videos };
    });

    res.json({
      success: true,
      listings
    });
  } catch (error) {
    console.error('Error in GET /api/listings:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/listings - create a new ad in unified ads table (all fields; null for unused per user/category)
// Media URLs reference files in storage bucket: user-photo-video
app.post('/api/listings', async (req, res) => {
  try {
    const body = req.body || {};
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
      address,
      phone,
      description,
      displayOption,
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
      constructionStatus,
      saleAtPresale,
      generalDetails,
      projectOffers,
      companyOffersLandSizes,
      salesImageUrl,
      profileImageUrl
    } = body;

    const additionalUrls = Array.isArray(additionalImageUrls) ? additionalImageUrls : [];
    const additionalImageUrlsJson = additionalUrls.filter(Boolean);

    // subscription_id must be a valid UUID; client may send "user-123" style ids
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const validSubscriptionId =
      subscriptionId && typeof subscriptionId === 'string' && uuidRegex.test(subscriptionId.trim())
        ? subscriptionId.trim()
        : null;

    const adRecord = {
      subscription_id: validSubscriptionId,
      subscription_type: subscriptionType || null,
      category: category != null ? parseInt(category, 10) : 1,
      status: status === 'published' ? 'published' : 'draft',
      main_image_url: mainImageUrl || null,
      additional_image_urls: additionalImageUrlsJson.length ? additionalImageUrlsJson : [],
      video_url: videoUrl || null,
      sales_image_url: salesImageUrl || null,
      profile_image_url: profileImageUrl || null,
      display_option: displayOption || null,
      property_type: propertyType || null,
      area: area != null ? parseInt(area, 10) : null,
      rooms: rooms != null ? parseInt(rooms, 10) : null,
      floor: floor != null ? parseInt(floor, 10) : null,
      purpose: purpose || 'sale',
      price: price != null ? parseFloat(price) : null,
      budget: budget != null ? parseFloat(budget) : null,
      price_per_night: pricePerNight != null ? parseFloat(pricePerNight) : null,
      amenities: amenities && typeof amenities === 'object' ? amenities : null,
      condition: condition || null,
      address: address || null,
      phone: phone || null,
      description: description || null,
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
      contact_details: contactDetails && typeof contactDetails === 'object' ? contactDetails : null,
      proposed_land: proposedLand && typeof proposedLand === 'object' ? proposedLand : null,
      plan_approval: planApproval || null,
      land_in_mortgage: landInMortgage || null,
      permit: permit || null,
      agricultural_land: agriculturalLand || null,
      land_ownership: landOwnership || null,
      land_address: landAddress || null,
      construction_status: constructionStatus || null,
      sale_at_presale: saleAtPresale !== undefined && saleAtPresale !== null ? (saleAtPresale === true || saleAtPresale === 'true') : null,
      general_details: generalDetails && typeof generalDetails === 'object' ? generalDetails : null,
      project_offers: projectOffers && typeof projectOffers === 'object' ? projectOffers : null,
      company_offers_land_sizes: companyOffersLandSizes && typeof companyOffersLandSizes === 'object' ? companyOffersLandSizes : null
    };

    const { data: ad, error: insertError } = await supabase
      .from('ads')
      .insert([adRecord])
      .select()
      .single();

    if (insertError) {
      console.error('Error creating ad:', insertError);
      return res.status(500).json({
        success: false,
        error: 'Failed to create listing',
        details: insertError.message
      });
    }

    res.status(201).json({
      success: true,
      id: ad.id,
      listing: ad
    });
  } catch (error) {
    console.error('Error in POST /api/listings:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== FILE UPLOAD ENDPOINTS ====================

// Upload file to Supabase Storage
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'No file provided. Ensure the form field is named "file".' 
      });
    }

    // Service role key is required for storage uploads; anon key will fail with RLS
    if (!supabaseKey || supabaseKey.includes('YOUR_SERVICE_ROLE_KEY_HERE')) {
      console.error('Upload failed: SUPABASE_SERVICE_ROLE_KEY is missing or still a placeholder.');
      return res.status(503).json({ 
        success: false, 
        error: 'Server upload not configured. Set SUPABASE_SERVICE_ROLE_KEY in the backend .env (Supabase Dashboard > Settings > API > service_role secret).' 
      });
    }

    const folder = (req.body && req.body.folder) ? String(req.body.folder).replace(/[^a-zA-Z0-9/_-]/g, '') : 'general';
    const safeName = (req.file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileName = `${folder}/${Date.now()}-${safeName}`;

    const { data, error } = await supabase.storage
      .from('user-pohto-video')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype || 'application/octet-stream',
        upsert: false
      });

    if (error) {
      console.error('Supabase storage upload error:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to upload file',
        details: error.message 
      });
    }

    const { data: urlData } = supabase.storage
      .from('user-pohto-video')
      .getPublicUrl(fileName);

    res.json({
      success: true,
      url: urlData.publicUrl,
      fileName: fileName
    });

  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Supabase URL: ${process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL}`);
});
