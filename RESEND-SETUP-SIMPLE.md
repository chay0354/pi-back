# Resend Setup - Simple Guide (No Domain Needed!)

## ✅ Quick Setup (5 minutes)

**You DON'T need to add a domain!** Resend provides a test domain that works immediately.

### Step 1: Get Your API Key

1. Go to https://resend.com and sign up/login
2. **SKIP the "Add Domain" page** - Just close it or click "Skip" if available
3. Go to **API Keys** in the sidebar
4. Click **"Create API Key"**
5. Give it a name (e.g., "PI Backend")
6. **Copy the key** - It starts with `re_` (e.g., `re_123456789abcdef...`)

### Step 2: Add to Your `.env` File

Open `back/.env` and add:

```env
RESEND_API_KEY=re_your_actual_key_here
EMAIL_FROM=onboarding@resend.dev
```

**Important:** Use `onboarding@resend.dev` - this is Resend's test domain that works without any setup!

### Step 3: Restart Your Backend

```bash
cd back
npm run dev
```

### Step 4: Test It!

Try submitting a subscription form - the verification email should be sent to the user's email address.

---

## 🎯 That's It!

You're done! Emails will be sent from `onboarding@resend.dev` and will work immediately.

**Limitations:**
- ✅ Works for development and testing
- ✅ No domain setup needed
- ✅ Instant setup
- ⚠️ Limited to 100 emails/day (free tier)
- ⚠️ Emails come from `onboarding@resend.dev` (not your domain)

---

## 📧 Want Your Own Domain Later?

If you want to send emails from your own domain (e.g., `noreply@yourdomain.com`), you can add it later:

1. In Resend dashboard, click **"Add Domain"**
2. Enter your domain (e.g., `yourdomain.com`)
3. Add the DNS records Resend provides to your domain registrar
4. Wait for verification (can take a few hours)
5. Update `.env`: `EMAIL_FROM=noreply@yourdomain.com`

But for now, **just use `onboarding@resend.dev`** - it works perfectly for development!
