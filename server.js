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

// Initialize Supabase client with longer timeout to reduce ConnectTimeoutError (e.g. 30s)
const FETCH_TIMEOUT_MS = Number(process.env.SUPABASE_FETCH_TIMEOUT_MS) || 30000;
const customFetch = (url, options = {}) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: options.signal || controller.signal })
    .finally(() => clearTimeout(timeoutId));
};

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
// Support correct name and common typo (SUPABASE_SERVICCE_ROLE_KEY)
let supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICCE_ROLE_KEY;

// Check if service role key is set and not a placeholder
if (!supabaseKey || supabaseKey.includes('YOUR_SERVICE_ROLE_KEY_HERE')) {
  console.warn('⚠️  WARNING: SUPABASE_SERVICE_ROLE_KEY not set or is a placeholder.');
  console.warn('⚠️  Using anon key as fallback. Some operations may fail.');
  console.warn('⚠️  Please set service_role key in .env from Supabase Dashboard > Settings > API');
  supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
}

const supabase = createClient(supabaseUrl, supabaseKey, { global: { fetch: customFetch } });

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

/** Send subscriber number (מספר מנוי) to verified account email – secret code recovery */
const sendSubscriberRecoveryEmail = async (email, subscriberNumber, subscriptionType) => {
  const typeNames = { broker: 'מתווכים', company: 'חברות', professional: 'בעלי מקצוע' };
  const typeName = typeNames[subscriptionType] || 'מנוי';
  const html = `
    <div dir="rtl" style="font-family: Arial, sans-serif; text-align: right;">
      <h2>שלום,</h2>
      <p>ביקשת לקבל את מספר המנוי שלך (${typeName}).</p>
      <p><strong>מספר המנוי שלך:</strong></p>
      <div style="background-color: #f0f0f0; padding: 20px; text-align: center; font-size: 28px; font-weight: bold; margin: 20px 0; border-radius: 8px;">
        ${subscriberNumber}
      </div>
      <p>אם לא ביקשת מייל זה, אנא התעלם.</p>
      <p>בברכה,<br>צוות PI</p>
    </div>
  `;
  if (resend) {
    try {
      await resend.emails.send({
        from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
        to: email,
        subject: 'מספר המנוי שלך – שחזור קוד',
        html,
      });
      console.log(`✅ Subscriber recovery email sent to ${email}`);
      return true;
    } catch (error) {
      console.error('❌ Error sending subscriber recovery email:', error);
    }
  }
  console.log(`\n📧 === SUBSCRIBER RECOVERY EMAIL ===\nTo: ${email}\nמספר מנוי: ${subscriberNumber}\n==========================\n`);
  return false;
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// ==================== AI SMART INFO (Gemini) ====================
// POST /api/ai/smart-info - body: { topic, topicLabel, address }
// Returns short Hebrew answer about the topic for the given address.
app.post('/api/ai/smart-info', async (req, res) => {
  try {
    const { topic, topicLabel, address } = req.body || {};
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ success: false, error: 'AI not configured', text: 'שירות המידע החכם לא מוגדר.' });
    }
    const addr = (address && String(address).trim()) || '';
    const label = (topicLabel && String(topicLabel).trim()) || (topic && String(topic)) || 'נושא';
    const prompt = `You are a helpful real-estate assistant. Answer in Hebrew only, in 2-4 short sentences.
Question: What can you tell me about "${label}" (${topic || label}) for the address/area: ${addr || 'Israel'}?
Give practical, factual info relevant to someone considering a property there. No preamble.`;
    // Use 2.5-flash-lite for better free-tier quota (15 RPM, 1000 RPD); fallback to 2.5-flash
    const modelsToTry = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash'];
    let lastError = null;
    let response = null;
    let triedUrl = '';
    for (const model of modelsToTry) {
      triedUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      response = await fetch(triedUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 256, temperature: 0.4 }
        })
      });
      if (response.ok) break;
      lastError = await response.text();
      if (response.status === 429) break; // quota - don't hammer other models
      if (response.status === 404) continue; // try next model
      break;
    }
    if (!response.ok) {
      const errText = lastError != null ? lastError : (await response.text());
      console.error('Gemini API error:', response.status, errText);
      if (response.status === 429) {
        return res.status(429).json({
          success: false,
          error: 'quota_exceeded',
          text: 'המכסה היומית של שירות המידע החכם הותשתה. נסה שוב מחר או בדוק את המכסות ב-Google AI Studio.'
        });
      }
      if (response.status === 404) {
        return res.status(502).json({ success: false, error: 'model_not_found', text: 'מודל AI לא זמין. נסה שוב מאוחר יותר.' });
      }
      return res.status(502).json({ success: false, error: 'AI request failed', text: 'לא ניתן לקבל מידע כרגע. נסה שוב מאוחר יותר.' });
    }
    const data = await response.json();
    const textPart = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const text = (textPart && String(textPart).trim()) || 'לא התקבל מידע.';
    return res.json({ success: true, text });
  } catch (err) {
    console.error('POST /api/ai/smart-info:', err);
    return res.status(500).json({ success: false, error: err.message, text: 'שגיאה בקבלת מידע. נסה שוב.' });
  }
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
      agreedToTerms,
      profile_picture_url // Optional: URL from stage-1 upload (profile-pics bucket)
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

    // Upload files to Supabase Storage (or use profile_picture_url if already uploaded at stage 1)
    const fileUrls = {};
    if (profile_picture_url && typeof profile_picture_url === 'string' && profile_picture_url.trim()) {
      fileUrls.profilePicture = profile_picture_url.trim();
    }
    if (req.files) {
      // Upload profile picture only if not already provided (e.g. uploaded when moving stage 1 → 2)
      if (!fileUrls.profilePicture && req.files.profilePicture && req.files.profilePicture[0]) {
        const profileFile = req.files.profilePicture[0];
        const safeName = (profileFile.originalname || 'photo').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '') || 'photo';
        const ext = safeName.includes('.') ? safeName.slice(safeName.lastIndexOf('.')) : '.jpg';
        const fileName = `profile-${Date.now()}${ext}`;
        const { data, error } = await supabase.storage
          .from('profile-pics')
          .upload(fileName, profileFile.buffer, {
            contentType: profileFile.mimetype,
            upsert: false
          });
        if (!error && data) {
          const { data: urlData } = supabase.storage
            .from('profile-pics')
            .getPublicUrl(fileName);
          fileUrls.profilePicture = urlData.publicUrl;
        } else if (error) {
          console.error('Profile picture upload to profile-pics failed:', error.message, '- Ensure bucket "profile-pics" exists in Supabase Storage.');
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

// Recover subscriber number by email (שחזור קוד סודי) – only verified subscriptions; always same response to avoid email enumeration
app.post('/api/subscription/recover-subscriber-code', async (req, res) => {
  try {
    const emailRaw = req.body && req.body.email != null ? String(req.body.email).trim() : '';
    const emailNorm = emailRaw.toLowerCase();
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm);
    if (!emailOk) {
      return res.status(400).json({
        success: false,
        error: 'אנא הזן כתובת מייל תקינה',
      });
    }

    const { data: rows, error } = await supabase
      .from('subscriptions')
      .select('subscriber_number, email, subscription_type')
      .eq('status', 'verified')
      .ilike('email', emailNorm)
      .limit(1);

    if (error) {
      console.error('recover-subscriber-code lookup:', error);
    }

    const subscription = rows && rows[0];
    if (subscription && subscription.subscriber_number != null && String(subscription.subscriber_number).trim() !== '') {
      const toEmail = subscription.email || emailRaw;
      await sendSubscriberRecoveryEmail(
        toEmail,
        String(subscription.subscriber_number).trim(),
        subscription.subscription_type,
      );
    } else {
      console.log(`recover-subscriber-code: no verified subscription for email (masked)`);
    }

    res.json({
      success: true,
      message: 'אם קיים חשבון למייל זה, נשלח אליו את מספר המנוי.',
    });
  } catch (error) {
    console.error('recover-subscriber-code:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get subscription by ID – same fields as listings builder so description and all subscription fields are returned
const SUBSCRIPTION_SELECT = 'id, email, name, contact_person_name, subscription_type, business_name, broker_office_name, profile_picture_url, company_logo_url, specializations, activity_regions, types, description, phone, mobile_phone, office_phone';
app.get('/api/subscription/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .select(SUBSCRIPTION_SELECT)
      .eq('id', id)
      .single();

    if (error || !subscription) {
      return res.status(200).json({
        success: false,
        subscription: null
      });
    }

    if (process.env.NODE_ENV !== 'production') {
      console.log('[GET /api/subscription/:id] id=', id, 'description=', subscription.description != null ? `"${String(subscription.description).slice(0, 50)}..."` : subscription.description);
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

// ==================== PROFILE REVIEWS ====================
// GET /api/reviews?target_subscription_id=uuid – list reviews for a profile
app.get('/api/reviews', async (req, res) => {
  try {
    const targetId = typeof req.query.target_subscription_id === 'string' ? req.query.target_subscription_id.trim() : null;
    if (!targetId) {
      return res.status(400).json({ success: false, error: 'target_subscription_id required' });
    }
    const { data: rows, error } = await supabase
      .from('profile_reviews')
      .select('id, target_subscription_id, reviewer_subscription_id, reviewer_name, reviewer_image_url, rating, comment, created_at')
      .eq('target_subscription_id', targetId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('GET /api/reviews error:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    const reviews = rows || [];
    const needEnrich = reviews.filter(r => r.reviewer_subscription_id && (!r.reviewer_name || !r.reviewer_image_url));
    if (needEnrich.length > 0) {
      const ids = [...new Set(needEnrich.map(r => r.reviewer_subscription_id))];
      const { data: subs } = await supabase
        .from('subscriptions')
        .select('id, name, contact_person_name, subscription_type, business_name, broker_office_name, profile_picture_url, company_logo_url')
        .in('id', ids);
      const byId = {};
      (subs || []).forEach(s => { byId[s.id] = s; });
      reviews.forEach(r => {
        if (!r.reviewer_subscription_id) return;
        const sub = byId[r.reviewer_subscription_id];
        const { name, imageUrl } = getSubscriptionDisplayNameAndImage(sub);
        if (name && !r.reviewer_name) r.reviewer_name = name;
        if (imageUrl && !r.reviewer_image_url) r.reviewer_image_url = imageUrl;
      });
    }
    res.json({ success: true, reviews });
  } catch (err) {
    console.error('GET /api/reviews:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper: get display name and image URL for a subscription (all 4 types: broker, company, professional, user)
function getSubscriptionDisplayNameAndImage(sub) {
  if (!sub) return { name: null, imageUrl: null };
  const type = (sub.subscription_type || '').toLowerCase();
  let name = null;
  if (type === 'company') name = sub.business_name || sub.name || sub.contact_person_name || null;
  else if (type === 'broker') name = sub.broker_office_name || sub.name || sub.contact_person_name || null;
  else if (type === 'professional') name = sub.name || sub.business_name || sub.contact_person_name || null;
  else name = sub.name || sub.contact_person_name || sub.business_name || sub.broker_office_name || null;
  const imageUrl = sub.profile_picture_url || (type === 'company' ? sub.company_logo_url : null) || null;
  return {
    name: name && String(name).trim() ? String(name).trim() : null,
    imageUrl: imageUrl && String(imageUrl).trim() ? String(imageUrl).trim() : null,
  };
}

// POST /api/reviews – add a review (rating 1–5 + optional comment)
app.post('/api/reviews', async (req, res) => {
  try {
    const { target_subscription_id, rating, comment, reviewer_name, reviewer_image_url, reviewer_subscription_id } = req.body || {};
    const targetId = target_subscription_id && String(target_subscription_id).trim() ? String(target_subscription_id).trim() : null;
    if (!targetId) {
      return res.status(400).json({ success: false, error: 'target_subscription_id required' });
    }
    const numRating = rating != null ? parseInt(rating, 10) : null;
    if (numRating == null || isNaN(numRating) || numRating < 1 || numRating > 5) {
      return res.status(400).json({ success: false, error: 'rating must be 1–5' });
    }
    const commentStr = comment != null ? String(comment).trim() : '';
    const rawReviewerSubId = reviewer_subscription_id && String(reviewer_subscription_id).trim() ? String(reviewer_subscription_id).trim() : null;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const reviewerSubId = rawReviewerSubId && uuidRegex.test(rawReviewerSubId) ? rawReviewerSubId : null;

    let finalReviewerName = reviewer_name && String(reviewer_name).trim() ? String(reviewer_name).trim() : null;
    let finalReviewerImageUrl = reviewer_image_url && String(reviewer_image_url).trim() ? String(reviewer_image_url).trim() : null;

    if (reviewerSubId) {
      const { data: sub } = await supabase
        .from('subscriptions')
        .select('name, contact_person_name, subscription_type, business_name, broker_office_name, profile_picture_url, company_logo_url')
        .eq('id', reviewerSubId)
        .maybeSingle();
      const { name, imageUrl } = getSubscriptionDisplayNameAndImage(sub);
      if (name) finalReviewerName = name;
      if (imageUrl) finalReviewerImageUrl = imageUrl;
    }

    const { data: row, error } = await supabase
      .from('profile_reviews')
      .insert({
        target_subscription_id: targetId,
        reviewer_subscription_id: reviewerSubId || null,
        rating: numRating,
        comment: commentStr || null,
        reviewer_name: finalReviewerName,
        reviewer_image_url: finalReviewerImageUrl,
      })
      .select('id, target_subscription_id, reviewer_subscription_id, reviewer_name, reviewer_image_url, rating, comment, created_at')
      .single();

    if (error) {
      console.error('POST /api/reviews error:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
    res.json({ success: true, review: row });
  } catch (err) {
    console.error('POST /api/reviews:', err);
    res.status(500).json({ success: false, error: err.message });
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

// Build preference profile from ads the user liked (price, location, category, purpose, rooms, area)
function buildPreferenceFromLikedAds(likedAdsRows) {
  if (!likedAdsRows || likedAdsRows.length === 0) return null;
  const prices = likedAdsRows.map(r => r.price).filter(p => p != null && !isNaN(Number(p)));
  const categories = likedAdsRows.map(r => r.category).filter(c => c != null);
  const purposes = likedAdsRows.map(r => r.purpose).filter(p => p != null && String(p).trim());
  const rooms = likedAdsRows.map(r => r.rooms).filter(r => r != null && !isNaN(Number(r)));
  const areas = likedAdsRows.map(r => r.area).filter(a => a != null && !isNaN(Number(a)));
  const addresses = likedAdsRows.map(r => (r.address || '').trim()).filter(Boolean);

  const freq = (arr) => {
    const m = {};
    arr.forEach((x) => { m[x] = (m[x] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ value: k, count: v }));
  };
  const median = (arr) => {
    if (arr.length === 0) return null;
    const s = [...arr].sort((a, b) => Number(a) - Number(b));
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? Number(s[mid]) : (Number(s[mid - 1]) + Number(s[mid])) / 2;
  };

  const priceMin = prices.length ? Math.min(...prices) : null;
  const priceMax = prices.length ? Math.max(...prices) : null;
  const priceMedian = median(prices);
  const categoryFreq = freq(categories);
  const purposeFreq = freq(purposes);
  const roomsMedian = median(rooms);
  const areaMedian = median(areas);
  const locationWords = new Set();
  addresses.forEach((addr) => {
    String(addr).split(/\s+|,|;/).forEach((w) => {
      const t = w.trim().replace(/[^\w\u0590-\u05FF]/g, '');
      if (t.length >= 2) locationWords.add(t.toLowerCase());
    });
  });

  return {
    priceMin,
    priceMax,
    priceMedian,
    categoryFreq,
    purposeFreq,
    roomsMedian,
    areaMedian,
    locationWords,
    likedCount: likedAdsRows.length,
  };
}

// Score one ad against preference profile (0..1). Higher = better match.
function scoreAdMatch(ad, pref) {
  if (!pref || pref.likedCount === 0) return 0.5;
  let score = 0;
  let weightSum = 0;

  const adPrice = ad.price != null ? Number(ad.price) : null;
  if (pref.priceMin != null && pref.priceMax != null && adPrice != null) {
    const range = pref.priceMax - pref.priceMin || 1;
    const dist = Math.min(Math.abs(adPrice - pref.priceMedian) / range, 1);
    score += (1 - dist) * 0.3;
    weightSum += 0.3;
  } else weightSum += 0.3;

  if (pref.categoryFreq.length > 0 && ad.category != null) {
    const top = pref.categoryFreq[0].value;
    const match = Number(ad.category) === Number(top) ? 1 : (pref.categoryFreq.some(c => Number(c.value) === Number(ad.category)) ? 0.5 : 0.1);
    score += match * 0.25;
    weightSum += 0.25;
  } else weightSum += 0.25;

  if (pref.purposeFreq.length > 0 && ad.purpose) {
    const top = pref.purposeFreq[0].value;
    const match = String(ad.purpose).toLowerCase() === String(top).toLowerCase() ? 1 : (pref.purposeFreq.some(p => String(p.value).toLowerCase() === String(ad.purpose).toLowerCase()) ? 0.5 : 0.1);
    score += match * 0.2;
    weightSum += 0.2;
  } else weightSum += 0.2;

  if (pref.locationWords.size > 0 && ad.address) {
    const adWords = String(ad.address).split(/\s+|,|;/).map(w => w.trim().replace(/[^\w\u0590-\u05FF]/g, '').toLowerCase()).filter(w => w.length >= 2);
    const overlap = adWords.filter(w => pref.locationWords.has(w)).length;
    const locationMatch = adWords.length ? Math.min(1, overlap / Math.max(adWords.length, 1) + 0.3) : 0.3;
    score += locationMatch * 0.15;
    weightSum += 0.15;
  } else weightSum += 0.15;

  if (pref.roomsMedian != null && ad.rooms != null) {
    const r = Number(ad.rooms);
    const diff = Math.abs(r - pref.roomsMedian);
    score += Math.max(0, 1 - diff / 4) * 0.1;
    weightSum += 0.1;
  } else weightSum += 0.1;

  if (pref.areaMedian != null && ad.area != null) {
    const a = Number(ad.area);
    const range = Math.max(pref.areaMedian * 0.5, 1);
    const diff = Math.min(Math.abs(a - pref.areaMedian) / range, 1);
    score += (1 - diff) * 0.05;
    weightSum += 0.05;
  } else weightSum += 0.05;

  return weightSum > 0 ? Math.min(1, score / (weightSum * 0.8)) : 0.5;
}

// Exposure multiplier: low = fewer impressions, medium = default, high = more
const EXPOSURE_MULTIPLIER = { low: 0.5, medium: 1, high: 1.5 };

// Sort listings by smart feed: preference match × exposure level (only when user_id provided and not owner view)
function sortListingsByFeedAlgorithm(adsRows, userIdParam, supabaseClient) {
  if (!adsRows || adsRows.length === 0 || !userIdParam) return Promise.resolve(adsRows);
  return (async () => {
    const { data: likesRows } = await supabaseClient.from('ad_likes').select('ad_id').eq('user_id', userIdParam);
    const likedAdIds = (likesRows || []).map(r => r.ad_id).filter(Boolean);
    if (likedAdIds.length === 0) {
      const withExp = adsRows.map((row) => {
        const lvl = (row.exposure_level || 'medium').toLowerCase();
        const mult = EXPOSURE_MULTIPLIER[lvl] ?? 1;
        return { row, score: mult };
      });
      withExp.sort((a, b) => b.score - a.score);
      return withExp.map(x => x.row);
    }
    const { data: likedAdsRows } = await supabaseClient.from('ads').select('id, price, category, purpose, rooms, area, address').in('id', likedAdIds);
    const pref = buildPreferenceFromLikedAds(likedAdsRows || []);

    const withScore = adsRows.map((row) => {
      const matchScore = scoreAdMatch(row, pref);
      const lvl = (row.exposure_level || 'medium').toLowerCase();
      const mult = EXPOSURE_MULTIPLIER[lvl] ?? 1;
      const finalScore = matchScore * mult;
      return { row, finalScore };
    });
    withScore.sort((a, b) => b.finalScore - a.finalScore);
    return withScore.map(x => x.row);
  })();
}

// GET /api/listings - fetch published listings from unified ads table (optional filter by category, subscription_type, has_video)
// Optional query: user_id - if provided, each listing gets liked: true/false and feed is sorted by smart algorithm (preferences from likes + exposure level).
// Media (images/video) are stored in bucket user-photo-video; URLs are in ads row.
app.get('/api/listings', async (req, res) => {
  try {
    const status = req.query.status || 'published';
    const category = req.query.category ? parseInt(req.query.category, 10) : null;
    const subscriptionTypeParam = typeof req.query.subscription_type === 'string' ? req.query.subscription_type.trim() : null;
    const hasVideo = req.query.has_video === 'true' || req.query.has_video === true;
    const subscriptionIdParam = typeof req.query.subscription_id === 'string' ? req.query.subscription_id.trim() : null;
    const userIdParam = typeof req.query.user_id === 'string' ? req.query.user_id.trim() : null;
    const favoritesOnly =
      req.query.favorites_only === 'true' ||
      req.query.favorites_only === true ||
      req.query.liked_only === 'true';

    let favoriteAdIds = null;
    if (favoritesOnly) {
      if (!userIdParam) {
        return res.status(400).json({
          success: false,
          error: 'user_id is required when favorites_only=true',
        });
      }
      try {
        const { data: likeRows, error: likeErr } = await supabase
          .from('ad_likes')
          .select('ad_id')
          .eq('user_id', userIdParam);
        if (likeErr) {
          console.warn('ad_likes query (favorites):', likeErr.message);
        }
        favoriteAdIds = (likeRows || []).map((r) => r.ad_id).filter(Boolean);
      } catch (e) {
        console.warn('ad_likes favorites:', e.message);
        favoriteAdIds = [];
      }
      if (!favoriteAdIds || favoriteAdIds.length === 0) {
        return res.json({ success: true, listings: [] });
      }
    }

    const allowedSubscriptionTypes = ['user', 'broker', 'company', 'professional'];
    const subscriptionTypes = subscriptionTypeParam
      ? subscriptionTypeParam.split(',').map(s => s.trim()).filter(s => allowedSubscriptionTypes.includes(s))
      : [];

    let query = supabase
      .from('ads')
      .select('*')
      .eq('status', status)
      .order('created_at', { ascending: false });

    if (favoriteAdIds && favoriteAdIds.length > 0) {
      query = query.in('id', favoriteAdIds);
    }

    if (category && !isNaN(category)) {
      query = query.eq('category', category);
    }
    if (subscriptionTypes.length === 1) {
      query = query.eq('subscription_type', subscriptionTypes[0]);
    } else if (subscriptionTypes.length > 1) {
      query = query.in('subscription_type', subscriptionTypes);
    }
    if (hasVideo) {
      query = query.not('video_url', 'is', null);
    }
    // subscription_id param = "owner view" (Edit/Publish Ad): show that owner's ads including frozen
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const validSubscriptionId = subscriptionIdParam && uuidRegex.test(subscriptionIdParam) ? subscriptionIdParam : null;
    const isOwnerView =
      !favoritesOnly && subscriptionIdParam != null && subscriptionIdParam.trim() !== '';
    if (isOwnerView) {
      if (validSubscriptionId) {
        query = query.eq('subscription_id', validSubscriptionId);
      } else {
        query = query.eq('owner_id', subscriptionIdParam.trim());
      }
      // Owner view: do not filter by is_frozen so frozen ads still appear in "my listings"
    } else {
      // Public feed: exclude frozen ads
      query = query.or('is_frozen.is.null,is_frozen.eq.false');
    }

    let result = await query;
    let { data: adsRows, error } = result;

    // If column doesn't exist or not in schema cache (is_frozen), retry without that filter
    const isFrozenColumnError = error && (
      error.code === '42703' ||
      error.code === 'PGRST204' ||
      (error.message && String(error.message).includes('is_frozen'))
    );
    if (isFrozenColumnError) {
      let fallbackQuery = supabase
        .from('ads')
        .select('*')
        .eq('status', status)
        .order('created_at', { ascending: false });
      if (favoriteAdIds && favoriteAdIds.length > 0) {
        fallbackQuery = fallbackQuery.in('id', favoriteAdIds);
      }
      if (category && !isNaN(category)) fallbackQuery = fallbackQuery.eq('category', category);
      if (subscriptionTypes.length === 1) fallbackQuery = fallbackQuery.eq('subscription_type', subscriptionTypes[0]);
      else if (subscriptionTypes.length > 1) fallbackQuery = fallbackQuery.in('subscription_type', subscriptionTypes);
      if (hasVideo) fallbackQuery = fallbackQuery.not('video_url', 'is', null);
      if (isOwnerView) {
        if (validSubscriptionId) fallbackQuery = fallbackQuery.eq('subscription_id', validSubscriptionId);
        else fallbackQuery = fallbackQuery.eq('owner_id', subscriptionIdParam.trim());
      }
      result = await fallbackQuery;
      adsRows = result.data;
      error = result.error;
    }

    if (error) {
      console.error('Error fetching listings:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch listings',
        details: error.message
      });
    }

    // Smart feed: when user_id provided and not owner view, sort by preference match (from liked ads) × exposure level
    if (userIdParam && !isOwnerView && adsRows && adsRows.length > 0 && !favoritesOnly) {
      try {
        adsRows = await sortListingsByFeedAlgorithm(adsRows, userIdParam, supabase);
      } catch (err) {
        console.warn('Feed algorithm sort failed, using default order:', err.message);
      }
    }

    // Optionally get liked ad ids for this user (view_count/like_count are on row; ensure they exist)
    let likedAdIds = new Set();
    if (favoritesOnly && adsRows && adsRows.length > 0) {
      adsRows.forEach((r) => { if (r.id) likedAdIds.add(r.id); });
    } else if (userIdParam && adsRows && adsRows.length > 0) {
      try {
        const adIds = adsRows.map(r => r.id).filter(Boolean);
        const { data: likesRows } = await supabase
          .from('ad_likes')
          .select('ad_id')
          .eq('user_id', userIdParam)
          .in('ad_id', adIds);
        if (likesRows && likesRows.length) {
          likesRows.forEach(r => { if (r.ad_id) likedAdIds.add(r.ad_id); });
        }
      } catch (_) { /* ad_likes table may not exist yet */ }
    }

    // Fetch creator (uploader) info from subscriptions for profile/chat display name
    const creatorBySubId = {};
    const fromSubscriptionId = [...new Set((adsRows || []).map(r => r.subscription_id).filter(Boolean))];
    const fromOwnerId = [...new Set((adsRows || []).map(r => r.owner_id).filter(Boolean).filter(id => uuidRegex.test(String(id))))];
    const subIds = [...new Set([...fromSubscriptionId, ...fromOwnerId])];
    if (subIds.length > 0) {
      try {
        const { data: subs } = await supabase
          .from('subscriptions')
          .select(SUBSCRIPTION_SELECT)
          .in('id', subIds);
        if (subs && subs.length) {
          subs.forEach(s => {
            // Display name by registration type (subscriptions has no agent_name column; broker agent is in "name")
            let displayName = null;
            const type = (s.subscription_type || '').toLowerCase();
            if (type === 'company') {
              displayName = s.business_name || s.name || s.contact_person_name || null;
            } else if (type === 'broker') {
              displayName = s.broker_office_name || s.name || s.contact_person_name || null;
            } else {
              displayName = s.name || s.business_name || s.contact_person_name || null;
            }
            let creatorSpecialties = null;
            if (s.specializations != null) {
              if (Array.isArray(s.specializations)) creatorSpecialties = s.specializations;
              else if (typeof s.specializations === 'string') {
                try {
                  const parsed = JSON.parse(s.specializations);
                  creatorSpecialties = Array.isArray(parsed) ? parsed : s.specializations.split(',').map(x => x.trim()).filter(Boolean);
                } catch (_) {
                  creatorSpecialties = s.specializations.split(',').map(x => x.trim()).filter(Boolean);
                }
              }
            }
            let creatorActivityRegions = null;
            if (s.activity_regions != null) {
              if (Array.isArray(s.activity_regions)) creatorActivityRegions = s.activity_regions;
              else if (typeof s.activity_regions === 'string') {
                try {
                  const parsed = JSON.parse(s.activity_regions);
                  creatorActivityRegions = Array.isArray(parsed) ? parsed : s.activity_regions.split(',').map(x => x.trim()).filter(Boolean);
                } catch (_) {
                  creatorActivityRegions = s.activity_regions.split(',').map(x => x.trim()).filter(Boolean);
                }
              }
            }
            let creatorTypes = null;
            if (s.types != null) {
              if (Array.isArray(s.types)) creatorTypes = s.types;
              else if (typeof s.types === 'string') {
                try {
                  const parsed = JSON.parse(s.types);
                  creatorTypes = Array.isArray(parsed) ? parsed : s.types.split(',').map(x => x.trim()).filter(Boolean);
                } catch (_) {
                  creatorTypes = s.types.split(',').map(x => x.trim()).filter(Boolean);
                }
              }
            }
            creatorBySubId[s.id] = {
              creator_email: s.email || null,
              creator_name: displayName || null,
              creator_profile_image_url:
                s.profile_picture_url ||
                (type === 'company' ? s.company_logo_url : null) ||
                null,
              creator_specialties: creatorSpecialties || null,
              creator_activity_regions: creatorActivityRegions || null,
              creator_types: creatorTypes || null,
              creator_bio: (s.description && String(s.description).trim()) ? String(s.description).trim() : null
            };
          });
        }
      } catch (_) {
        try {
          const { data: subs } = await supabase
            .from('subscriptions')
            .select('id, email, name, contact_person_name')
            .in('id', subIds);
          if (subs && subs.length) {
            subs.forEach(s => {
              const name = s.name || s.contact_person_name || null;
              creatorBySubId[s.id] = { creator_email: s.email || null, creator_name: name || null };
            });
          }
        } catch (_) { /* ignore */ }
      }
      // Regular users (e.g. user-xxx) are not in subscriptions; use chat_participants for creator name/pic
      const missingSubIds = subIds.filter((id) => !creatorBySubId[id]);
      if (missingSubIds.length > 0) {
        try {
          const { data: participantRows } = await supabase
            .from('chat_participants')
            .select('user_id, display_name, profile_picture_url')
            .in('user_id', missingSubIds);
          const byUser = {};
          (participantRows || []).forEach((p) => {
            if (p.user_id && !byUser[p.user_id] && (p.display_name || p.profile_picture_url)) {
              byUser[p.user_id] = {
                creator_email: null,
                creator_name: p.display_name || null,
                creator_profile_image_url: p.profile_picture_url || null,
              };
            }
          });
          Object.assign(creatorBySubId, byUser);
        } catch (_) { /* ignore */ }
      }
    }

    // Shape for frontend: add listing_images, listing_videos, view_count, like_count, liked, creator_*
    const listings = (adsRows || []).map((row) => {
      const creator = (row.subscription_id && creatorBySubId[row.subscription_id])
        ? creatorBySubId[row.subscription_id]
        : (row.owner_id && creatorBySubId[row.owner_id])
          ? creatorBySubId[row.owner_id]
          : {};
      // Prefer creator saved on the ad at upload time (real uploader details)
      const listing_images = [];
      if (row.main_image_url) {
        listing_images.push({ image_url: row.main_image_url, image_type: 'main' });
      }
      const additional = Array.isArray(row.additional_image_urls) ? row.additional_image_urls : [];
      additional.forEach((url) => {
        if (url) listing_images.push({ image_url: url, image_type: 'additional' });
      });
      const listing_videos = row.video_url ? [{ video_url: row.video_url }] : [];
      return {
        ...row,
        view_count: row.view_count != null ? Number(row.view_count) : 0,
        like_count: row.like_count != null ? Number(row.like_count) : 0,
        liked: userIdParam ? likedAdIds.has(row.id) : undefined,
        listing_images,
        listing_videos,
        is_frozen: row.is_frozen === true || row.is_frozen === 't',
        creator_name: row.creator_name ?? creator.creator_name ?? null,
        creator_email: row.creator_email ?? creator.creator_email ?? null,
        creator_profile_image_url: row.profile_image_url ?? creator.creator_profile_image_url ?? null,
        creator_specialties: creator.creator_specialties || null,
        creator_activity_regions: creator.creator_activity_regions || null,
        creator_types: creator.creator_types || null,
        creator_bio: creator.creator_bio || null
      };
    });

    res.json({
      success: true,
      listings
    });
  } catch (error) {
    console.error('Error in GET /api/listings:', error);
    const isNetworkError =
      error.message === 'fetch failed' ||
      (error.cause && typeof error.cause.message === 'string') ||
      (error.message && String(error.message).includes('fetch failed')) ||
      (error.code && ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ETIMEDOUT'].includes(error.code));
    if (isNetworkError) {
      // Return empty listings so the app can load instead of showing a hard error
      console.warn('Supabase unreachable; returning empty listings.');
      return res.status(200).json({
        success: true,
        listings: [],
        offline: true,
        message: 'Could not reach database. Showing empty feed.'
      });
    }
    const message = error.message || 'Failed to fetch listings';
    res.status(500).json({
      success: false,
      error: message,
      details: error.cause?.message || error.message
    });
  }
});

// ==================== STORIES (separate from ads) ====================

function subscriptionDisplayNameForStory(sub) {
  if (!sub) return 'משתמש';
  const type = String(sub.subscription_type || '').toLowerCase();
  if (type === 'company') {
    return sub.business_name || sub.name || sub.contact_person_name || 'משתמש';
  }
  if (type === 'broker') {
    return sub.broker_office_name || sub.name || sub.contact_person_name || 'משתמש';
  }
  return sub.name || sub.business_name || sub.contact_person_name || 'משתמש';
}

// GET /api/stories/feed — active story rings (last 24h), grouped by subscription
app.get('/api/stories/feed', async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: rows, error } = await supabase
      .from('stories')
      .select('id, subscription_id, media_url, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: true });

    if (error) {
      if (
        String(error.message || '').includes('does not exist') ||
        error.code === '42P01'
      ) {
        return res.json({
          success: true,
          rings: [],
          message: 'stories table missing; run migration-stories.sql',
        });
      }
      console.error('GET /api/stories/feed:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    const bySub = {};
    for (const row of rows || []) {
      const sid = row.subscription_id;
      if (!sid) continue;
      if (!bySub[sid]) bySub[sid] = [];
      bySub[sid].push({
        id: row.id,
        media_url: row.media_url,
        created_at: row.created_at,
      });
    }
    const subIds = Object.keys(bySub);
    if (subIds.length === 0) {
      return res.json({ success: true, rings: [] });
    }

    const { data: subs, error: subErr } = await supabase
      .from('subscriptions')
      .select(
        'id, email, name, contact_person_name, subscription_type, business_name, broker_office_name, profile_picture_url, company_logo_url',
      )
      .in('id', subIds);

    if (subErr) {
      console.error('GET /api/stories/feed subscriptions:', subErr);
    }
    const subMap = {};
    (subs || []).forEach((s) => {
      subMap[s.id] = s;
    });

    const rings = subIds.map((sid) => {
      const s = subMap[sid];
      const st = (s?.subscription_type || '').toLowerCase();
      const storyPic =
        s?.profile_picture_url ||
        (st === 'company' ? s?.company_logo_url : null) ||
        null;
      return {
        subscription_id: sid,
        display_name: subscriptionDisplayNameForStory(s),
        profile_image_url: storyPic,
        slides: bySub[sid],
      };
    });

    res.json({ success: true, rings });
  } catch (err) {
    console.error('GET /api/stories/feed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/stories — body: { subscription_id, media_url }
app.post('/api/stories', async (req, res) => {
  try {
    const { subscription_id: subscriptionId, media_url: mediaUrl } = req.body || {};
    const sid = subscriptionId && String(subscriptionId).trim();
    const url = mediaUrl && String(mediaUrl).trim();
    if (!sid || !url) {
      return res.status(400).json({
        success: false,
        error: 'subscription_id and media_url are required',
      });
    }

    const { data, error } = await supabase
      .from('stories')
      .insert([{ subscription_id: sid, media_url: url }])
      .select()
      .single();

    if (error) {
      console.error('POST /api/stories:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    res.status(201).json({ success: true, story: data });
  } catch (err) {
    console.error('POST /api/stories:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== CHAT ENDPOINTS ====================
// Simple email-based chat: users identified by email (chat_participants.user_id and chat_messages.sender_id/receiver_id store normalized email).

function normEmail(email) {
  return (email != null ? String(email).trim().toLowerCase() : '') || '';
}

// GET /api/chat/unread-count?user_email=...&after=:iso_timestamp
app.get('/api/chat/unread-count', async (req, res) => {
  try {
    const userEmail = normEmail(req.query.user_email);
    if (!userEmail) return res.status(400).json({ success: false, error: 'user_email required' });
    const after = (req.query.after && String(req.query.after).trim()) || null;
    let query = supabase.from('chat_messages').select('id', { count: 'exact', head: true }).eq('receiver_id', userEmail);
    if (after) query = query.gt('created_at', after);
    const { count, error } = await query;
    if (error) {
      console.error('GET /api/chat/unread-count:', error.message);
      return res.json({ success: true, count: 0 });
    }
    res.json({ success: true, count: typeof count === 'number' ? count : 0 });
  } catch (err) {
    console.error('GET /api/chat/unread-count:', err);
    res.json({ success: true, count: 0 });
  }
});

// GET /api/chat/conversations?user_email=...
app.get('/api/chat/conversations', async (req, res) => {
  try {
    const userEmail = normEmail(req.query.user_email);
    if (!userEmail) return res.status(400).json({ success: false, error: 'user_email required' });

    const { data: myParts } = await supabase
      .from('chat_participants')
      .select('conversation_id')
      .eq('user_id', userEmail);
    const convIds = [...new Set((myParts || []).map(p => p.conversation_id))];
    if (convIds.length === 0) return res.json({ success: true, conversations: [] });

    const { data: allParticipants } = await supabase
      .from('chat_participants')
      .select('conversation_id, user_id, display_name, profile_picture_url')
      .in('conversation_id', convIds);
    const participantsByConv = {};
    (allParticipants || []).forEach(p => {
      if (!participantsByConv[p.conversation_id]) participantsByConv[p.conversation_id] = [];
      participantsByConv[p.conversation_id].push(p);
    });

    const { data: convs } = await supabase
      .from('chat_conversations')
      .select('id, last_message_at')
      .in('id', convIds)
      .order('last_message_at', { ascending: false, nullsFirst: false });

    const { data: lastMessages } = await supabase
      .from('chat_messages')
      .select('conversation_id, body, created_at, sender_id')
      .in('conversation_id', convIds);
    const lastByConv = {};
    (lastMessages || []).forEach(m => {
      if (!lastByConv[m.conversation_id] || new Date(m.created_at) > new Date(lastByConv[m.conversation_id].created_at)) {
        lastByConv[m.conversation_id] = m;
      }
    });

    const otherEmails = [...new Set(
      (convs || []).flatMap(c => (participantsByConv[c.id] || []).map(p => p.user_id).filter(e => normEmail(e) !== userEmail))
    )];
    let displayByEmail = {};
    if (otherEmails.length > 0) {
      const orFilter = otherEmails.map(e => `email.ilike.${e}`).join(',');
      const { data: subs } = await supabase.from('subscriptions').select('email, name, contact_person_name, subscription_type, business_name, broker_office_name, profile_picture_url, company_logo_url').or(orFilter);
      (subs || []).forEach(s => {
        const e = normEmail(s.email);
        if (!otherEmails.includes(e)) return;
        const type = (s.subscription_type || '').toLowerCase();
        let name = null;
        if (type === 'company') name = s.business_name || s.name || s.contact_person_name || null;
        else if (type === 'broker') name = s.broker_office_name || s.name || s.contact_person_name || null;
        else if (type === 'professional') name = s.name || s.business_name || s.contact_person_name || null;
        else name = s.name || s.contact_person_name || s.business_name || null;
        displayByEmail[e] = { name: name || null, profile_picture_url: s.profile_picture_url || (type === 'company' ? s.company_logo_url : null) || null };
      });
      (allParticipants || []).forEach(p => {
        const e = normEmail(p.user_id);
        if (!displayByEmail[e] && (p.display_name || p.profile_picture_url)) {
          displayByEmail[e] = { name: p.display_name || null, profile_picture_url: p.profile_picture_url || null };
        }
      });
    }

    const conversations = (convs || []).map(c => {
      const participants = participantsByConv[c.id] || [];
      const other = participants.find(p => normEmail(p.user_id) !== userEmail);
      const otherEmail = other ? normEmail(other.user_id) : null;
      const display = otherEmail ? displayByEmail[otherEmail] : {};
      const name = display?.name || (other && other.display_name) || 'משתמש';
      const profileImageUrl = display?.profile_picture_url || (other && other.profile_picture_url) || null;
      const last = lastByConv[c.id];
      return {
        id: c.id,
        otherUserEmail: otherEmail,
        name,
        profileImageUrl,
        preview: last ? (last.body || '').slice(0, 80) : '',
        time: last ? new Date(last.created_at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : '',
        lastMessageAt: c.last_message_at,
      };
    });

    const byOther = {};
    conversations.forEach(conv => {
      const oid = conv.otherUserEmail || conv.id;
      const existing = byOther[oid];
      if (!existing || (conv.lastMessageAt && (!existing.lastMessageAt || new Date(conv.lastMessageAt) > new Date(existing.lastMessageAt)))) {
        byOther[oid] = conv;
      }
    });
    res.json({ success: true, conversations: Object.values(byOther) });
  } catch (err) {
    console.error('GET /api/chat/conversations:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/chat/participant-display?user_email=...
app.get('/api/chat/participant-display', async (req, res) => {
  try {
    const userEmail = normEmail(req.query.user_email);
    if (!userEmail) return res.status(400).json({ success: false, error: 'user_email required' });

    const { data: participantRows } = await supabase
      .from('chat_participants')
      .select('display_name, profile_picture_url')
      .eq('user_id', userEmail)
      .limit(1);
    const row = participantRows && participantRows[0];
    if (row && (row.display_name || row.profile_picture_url)) {
      return res.json({ success: true, name: row.display_name || null, profileImageUrl: row.profile_picture_url || null });
    }

    const { data: sub } = await supabase
      .from('subscriptions')
      .select('name, contact_person_name, subscription_type, business_name, broker_office_name, profile_picture_url, company_logo_url')
      .ilike('email', userEmail)
      .maybeSingle();
    if (sub) {
      const type = (sub.subscription_type || '').toLowerCase();
      let displayName = null;
      if (type === 'company') displayName = sub.business_name || sub.name || sub.contact_person_name || null;
      else if (type === 'broker') displayName = sub.broker_office_name || sub.name || sub.contact_person_name || null;
      else if (type === 'professional') displayName = sub.name || sub.business_name || sub.contact_person_name || null;
      else displayName = sub.name || sub.contact_person_name || sub.business_name || null;
      const profilePic = sub.profile_picture_url || (type === 'company' ? sub.company_logo_url : null) || null;
      return res.json({ success: true, name: displayName || null, profileImageUrl: profilePic || null });
    }
    res.json({ success: true, name: null, profileImageUrl: null });
  } catch (err) {
    console.error('GET /api/chat/participant-display:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/chat/messages?user_email=...&other_user_email=...
app.get('/api/chat/messages', async (req, res) => {
  try {
    const myEmail = normEmail(req.query.user_email);
    const otherEmail = normEmail(req.query.other_user_email);
    if (!myEmail || !otherEmail) return res.status(400).json({ success: false, error: 'user_email and other_user_email required' });

    const { data: myParts } = await supabase.from('chat_participants').select('conversation_id').eq('user_id', myEmail);
    const { data: otherParts } = await supabase.from('chat_participants').select('conversation_id').eq('user_id', otherEmail);
    const myConvIds = new Set((myParts || []).map(p => p.conversation_id));
    let sharedConvId = (otherParts || []).find(p => myConvIds.has(p.conversation_id))?.conversation_id || null;

    if (!sharedConvId && (otherParts || []).length > 0) {
      const convId = (otherParts || [])[0].conversation_id;
      const { data: parts } = await supabase.from('chat_participants').select('user_id').eq('conversation_id', convId);
      if ((parts || []).length === 1) {
        await supabase.from('chat_participants').insert({ conversation_id: convId, user_id: myEmail });
        sharedConvId = convId;
      }
    }

    if (!sharedConvId) return res.json({ success: true, messages: [] });

    const { data: messages } = await supabase
      .from('chat_messages')
      .select('id, sender_id, body, created_at')
      .eq('conversation_id', sharedConvId)
      .order('created_at', { ascending: true });

    const list = (messages || []).map(m => {
      const isMe = normEmail(m.sender_id) === myEmail;
      return {
        id: m.id,
        senderId: m.sender_id,
        body: m.body,
        createdAt: m.created_at,
        isMe,
      };
    });
    res.json({ success: true, messages: list, conversation_id: sharedConvId });
  } catch (err) {
    console.error('GET /api/chat/messages:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/chat/messages - body: sender_email, receiver_email, body; optional display names/pics
app.post('/api/chat/messages', async (req, res) => {
  try {
    const senderEmail = normEmail(req.body.sender_email || req.query.sender_email);
    const receiverEmail = normEmail(req.body.receiver_email || req.query.receiver_email);
    const body = req.body.body != null ? String(req.body.body).trim() : null;
    const receiverDisplayName = req.body.receiver_display_name != null ? String(req.body.receiver_display_name).trim() || null : null;
    const receiverProfilePictureUrl = req.body.receiver_profile_picture_url != null ? String(req.body.receiver_profile_picture_url).trim() || null : null;
    const senderDisplayName = req.body.sender_display_name != null ? String(req.body.sender_display_name).trim() || null : null;
    const senderProfilePictureUrl = req.body.sender_profile_picture_url != null ? String(req.body.sender_profile_picture_url).trim() || null : null;

    if (!senderEmail || !receiverEmail || body === null || body === '') {
      return res.status(400).json({ success: false, error: 'sender_email, receiver_email, and body required' });
    }

    let convId = null;
    const { data: senderConvs } = await supabase.from('chat_participants').select('conversation_id').eq('user_id', senderEmail);
    const senderConvIds = (senderConvs || []).map(p => p.conversation_id);
    if (senderConvIds.length > 0) {
      const { data: otherIn } = await supabase.from('chat_participants').select('conversation_id').eq('user_id', receiverEmail).in('conversation_id', senderConvIds);
      for (const r of otherIn || []) {
        const { data: parts } = await supabase.from('chat_participants').select('user_id').eq('conversation_id', r.conversation_id);
        const emails = (parts || []).map(p => normEmail(p.user_id));
        if (emails.length === 2 && emails.includes(senderEmail) && emails.includes(receiverEmail)) {
          convId = r.conversation_id;
          break;
        }
      }
    }
    if (!convId) {
      const { data: newConv, error: newConvErr } = await supabase.from('chat_conversations').insert({ type: 'direct' }).select('id').single();
      if (newConvErr || !newConv?.id) return res.status(500).json({ success: false, error: 'Failed to create conversation' });
      convId = newConv.id;
      const { error: insertErr } = await supabase.from('chat_participants').insert([
        { conversation_id: convId, user_id: senderEmail },
        { conversation_id: convId, user_id: receiverEmail },
      ]);
      if (insertErr) return res.status(500).json({ success: false, error: insertErr.message });
      if (receiverDisplayName != null || receiverProfilePictureUrl != null) {
        const u = {};
        if (receiverDisplayName != null) u.display_name = receiverDisplayName;
        if (receiverProfilePictureUrl != null) u.profile_picture_url = receiverProfilePictureUrl;
        if (Object.keys(u).length > 0) await supabase.from('chat_participants').update(u).eq('conversation_id', convId).eq('user_id', receiverEmail);
      }
      if (senderDisplayName != null || senderProfilePictureUrl != null) {
        const u = {};
        if (senderDisplayName != null) u.display_name = senderDisplayName;
        if (senderProfilePictureUrl != null) u.profile_picture_url = senderProfilePictureUrl;
        if (Object.keys(u).length > 0) await supabase.from('chat_participants').update(u).eq('conversation_id', convId).eq('user_id', senderEmail);
      }
    } else {
      if (receiverDisplayName != null || receiverProfilePictureUrl != null) {
        const u = {};
        if (receiverDisplayName != null) u.display_name = receiverDisplayName;
        if (receiverProfilePictureUrl != null) u.profile_picture_url = receiverProfilePictureUrl;
        if (Object.keys(u).length > 0) await supabase.from('chat_participants').update(u).eq('conversation_id', convId).eq('user_id', receiverEmail);
      }
      if (senderDisplayName != null || senderProfilePictureUrl != null) {
        const u = {};
        if (senderDisplayName != null) u.display_name = senderDisplayName;
        if (senderProfilePictureUrl != null) u.profile_picture_url = senderProfilePictureUrl;
        if (Object.keys(u).length > 0) await supabase.from('chat_participants').update(u).eq('conversation_id', convId).eq('user_id', senderEmail);
      }
    }

    const insertPayload = { conversation_id: convId, sender_id: senderEmail, receiver_id: receiverEmail, body };
    const { data: msg, error } = await supabase.from('chat_messages').insert(insertPayload).select('id, sender_id, body, created_at').single();
    if (error) {
      const fallback = await supabase.from('chat_messages').insert({ conversation_id: convId, sender_id: senderEmail, body }).select('id, sender_id, body, created_at').single();
      if (fallback.error) return res.status(500).json({ success: false, error: fallback.error.message });
      await supabase.from('chat_conversations').update({ last_message_at: fallback.data.created_at }).eq('id', convId);
      return res.json({ success: true, message: { id: fallback.data.id, senderId: fallback.data.sender_id, body: fallback.data.body, createdAt: fallback.data.created_at, isMe: true } });
    }
    await supabase.from('chat_conversations').update({ last_message_at: msg.created_at }).eq('id', convId);
    res.json({ success: true, message: { id: msg.id, senderId: msg.sender_id, body: msg.body, createdAt: msg.created_at, isMe: true } });
  } catch (err) {
    console.error('POST /api/chat/messages:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/listings/:id/view - record a view (increment view_count)
app.post('/api/listings/:id/view', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, error: 'Missing listing id' });
    const { data: row, error: selectError } = await supabase.from('ads').select('view_count').eq('id', id).maybeSingle();
    if (selectError) {
      console.warn('View count select failed (column may be missing):', selectError.message);
      return res.status(200).json({ success: true });
    }
    const current = row?.view_count != null ? Number(row.view_count) : 0;
    const { error } = await supabase.from('ads').update({ view_count: current + 1 }).eq('id', id);
    if (error) {
      console.warn('View count update failed:', error.message);
      return res.status(200).json({ success: true });
    }
    return res.json({ success: true });
  } catch (e) {
    console.error('Error recording view:', e);
    return res.status(200).json({ success: true });
  }
});

// POST /api/listings/:id/like - add like (user_id in body); increment ads.like_count if column exists
app.post('/api/listings/:id/like', async (req, res) => {
  try {
    const id = req.params.id;
    const user_id = (req.body && req.body.user_id != null) ? String(req.body.user_id).trim() : (req.query.user_id && String(req.query.user_id).trim());
    if (!id || !user_id) return res.status(400).json({ success: false, error: 'Missing listing id or user_id' });
    const { error } = await supabase.from('ad_likes').insert({ ad_id: id, user_id });
    if (error && error.code !== '23505') return res.status(500).json({ success: false, error: error.message }); // 23505 = duplicate key, already liked
    if (!error) {
      const { data: row, error: selectError } = await supabase.from('ads').select('like_count').eq('id', id).maybeSingle();
      if (!selectError && row != null) {
        const current = row.like_count != null ? Number(row.like_count) : 0;
        await supabase.from('ads').update({ like_count: current + 1 }).eq('id', id);
      }
    }
    return res.json({ success: true });
  } catch (e) {
    console.error('Error adding like:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/listings/:id/like - remove like (user_id in query or body); decrement ads.like_count if column exists
app.delete('/api/listings/:id/like', async (req, res) => {
  try {
    const id = req.params.id;
    const user_id = (req.body && req.body.user_id != null) ? String(req.body.user_id).trim() : (req.query && req.query.user_id && String(req.query.user_id).trim());
    if (!id || !user_id) return res.status(400).json({ success: false, error: 'Missing listing id or user_id' });
    const { error } = await supabase.from('ad_likes').delete().eq('ad_id', id).eq('user_id', user_id);
    if (error) return res.status(500).json({ success: false, error: error.message });
    const { data: row, error: selectError } = await supabase.from('ads').select('like_count').eq('id', id).maybeSingle();
    if (!selectError && row != null) {
      const current = row.like_count != null ? Number(row.like_count) : 0;
      await supabase.from('ads').update({ like_count: Math.max(0, current - 1) }).eq('id', id);
    }
    return res.json({ success: true });
  } catch (e) {
    console.error('Error removing like:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});
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
      constructionStatus,
      saleAtPresale,
      generalDetails,
      projectOffers,
      companyOffersLandSizes,
      salesImageUrl,
      profileImageUrl,
      overlay_x: overlayX,
      overlay_y: overlayY,
      exposure_level: exposureLevel
    } = body;

    const additionalUrls = Array.isArray(additionalImageUrls) ? additionalImageUrls : [];
    const additionalImageUrlsJson = additionalUrls.filter(Boolean);

    // subscription_id must be a valid UUID; client may send "user-123" style ids
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const validSubscriptionId =
      subscriptionId && typeof subscriptionId === 'string' && uuidRegex.test(subscriptionId.trim())
        ? subscriptionId.trim()
        : null;

    // Save uploader (creator) name and email from subscription so listing always shows who uploaded it
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
      } catch (_) { /* ignore */ }
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
      display_option: displayOption || null,
      feed_display_priority: feedDisplayPriority === 'mainImage' ? 'mainImage' : (feedDisplayPriority === 'video' ? 'video' : null),
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
      project_name: projectName != null && String(projectName).trim() !== '' ? String(projectName).trim() : null,
      address: address || null,
      phone: phone || null,
      description: description || null,
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
      company_offers_land_sizes: companyOffersLandSizes && typeof companyOffersLandSizes === 'object' ? companyOffersLandSizes : null,
      exposure_level: ['low', 'medium', 'high'].includes(String(exposureLevel || '').toLowerCase()) ? String(exposureLevel).toLowerCase() : 'medium'
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

// PATCH /api/listings/:id - update a listing (e.g. is_frozen, exposure_level)
app.patch('/api/listings/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const body = req.body || {};
    const { is_frozen: isFrozen, exposure_level: exposureLevel } = body;

    if (id == null || id === '') {
      return res.status(400).json({ success: false, error: 'Listing id required' });
    }

    const updates = {};
    if (['low', 'medium', 'high'].includes(String(exposureLevel || '').toLowerCase())) {
      updates.exposure_level = String(exposureLevel).toLowerCase();
    }
    if (typeof isFrozen === 'boolean') {
      updates.is_frozen = isFrozen;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }

    const { data: ad, error } = await supabase
      .from('ads')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating listing:', error);
      // PGRST204 = column not in schema cache (migration not run or Supabase cache stale)
      if (error.code === 'PGRST204' && (error.message || '').includes('is_frozen')) {
        return res.status(503).json({
          success: false,
          error: 'Database schema missing is_frozen column. Run the migration in Supabase SQL Editor (migration-ads-add-is-frozen.sql) and wait a few seconds for the schema cache to refresh.',
          code: 'SCHEMA_MIGRATION_NEEDED'
        });
      }
      return res.status(500).json({
        success: false,
        error: 'Failed to update listing',
        details: error.message
      });
    }
    if (!ad) {
      return res.status(404).json({ success: false, error: 'Listing not found' });
    }

    res.json({ success: true, listing: ad });
  } catch (error) {
    console.error('Error in PATCH /api/listings/:id:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== FILE UPLOAD ENDPOINTS ====================

// Upload profile picture to bucket profile-pics (e.g. when moving from stage 1 to stage 2)
app.post('/api/upload-profile-pic', upload.single('profilePicture'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No profile picture provided.' });
    }
    if (!supabaseKey || supabaseKey.includes('YOUR_SERVICE_ROLE_KEY_HERE')) {
      return res.status(503).json({ success: false, error: 'Server upload not configured.' });
    }
    // Supabase storage keys must be ASCII-safe (no Hebrew/special chars)
    const ext = (req.file.originalname || '').includes('.') ? (req.file.originalname.match(/\.([a-zA-Z0-9]+)$/)?.[1] || 'jpg') : 'jpg';
    const fileName = `profile-${Date.now()}.${ext.replace(/[^a-zA-Z0-9]/g, '') || 'jpg'}`;
    const { data, error } = await supabase.storage
      .from('profile-pics')
      .upload(fileName, req.file.buffer, { contentType: req.file.mimetype || 'image/jpeg', upsert: false });
    if (error) {
      console.error('Profile pic upload error:', error);
      return res.status(500).json({ success: false, error: 'Failed to upload profile picture.' });
    }
    const { data: urlData } = supabase.storage.from('profile-pics').getPublicUrl(fileName);
    res.json({ success: true, url: urlData.publicUrl });
  } catch (err) {
    console.error('Upload profile pic:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

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

// Start server (0.0.0.0 = accept connections from any network interface, so you can access from other devices)
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
  console.log(`Supabase URL: ${process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL}`);
});
