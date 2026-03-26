# Resend Quick Start Guide

## Option 1: Use Test Domain (Easiest - For Development)

**You don't need to add a domain for testing!**

1. **Skip the "Add Domain" page** - Just close it or go back
2. **Go to API Keys** - Click on "API Keys" in the sidebar
3. **Create API Key** - Click "Create API Key"
4. **Copy the key** - It will look like `re_123456789...`
5. **Add to `.env`**:
   ```env
   RESEND_API_KEY=re_your_key_here
   EMAIL_FROM=onboarding@resend.dev
   ```
   Note: Use `onboarding@resend.dev` as the sender for testing (Resend's test domain)

6. **Restart backend**:
   ```bash
   cd back
   npm run dev
   ```

**Limitations of test domain:**
- ✅ Works for development/testing
- ✅ No domain setup needed
- ❌ Emails come from `onboarding@resend.dev`
- ❌ Limited to 100 emails/day (free tier)

---

## Option 2: Add Your Own Domain (For Production)

Only do this if you want to send emails from your own domain (e.g., `noreply@yourdomain.com`).

### Steps:

1. **Click "Add Domain"** on the page you're seeing
2. **Enter your domain** (e.g., `yourdomain.com`)
3. **Select region** (choose closest to your users)
4. **Add DNS records** - Resend will show you DNS records to add:
   - Go to your domain registrar (GoDaddy, Namecheap, etc.)
   - Add the DNS records Resend provides
   - Wait for DNS propagation (can take a few hours)
5. **Verify domain** - Resend will verify once DNS records are added
6. **Update `.env`**:
   ```env
   RESEND_API_KEY=re_your_key_here
   EMAIL_FROM=noreply@yourdomain.com
   ```

**Pros:**
- ✅ Professional email addresses
- ✅ Better deliverability
- ✅ Branded emails

**Cons:**
- ❌ Requires domain ownership
- ❌ DNS setup required
- ❌ Takes time to verify

---

## Recommendation

**For now, use Option 1 (Test Domain)** - it's instant and perfect for development. You can add your own domain later when you're ready for production.
