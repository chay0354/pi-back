# Email Verification Setup Guide

## Option 1: Resend (Recommended - Easiest)

### Steps:

1. **Sign up for Resend**
   - Go to https://resend.com
   - Create a free account (100 emails/day free)
   - Verify your domain or use their test domain

2. **Get API Key**
   - Go to https://resend.com/api-keys
   - Create a new API key
   - Copy the key

3. **Update `.env` file**
   ```env
   RESEND_API_KEY=re_your_api_key_here
   EMAIL_FROM=noreply@yourdomain.com
   ```

4. **Restart backend**
   ```bash
   npm run dev
   ```

**Pros:**
- ✅ Simple setup
- ✅ Free tier: 100 emails/day
- ✅ Good deliverability
- ✅ Works great with Supabase

---

## Option 2: Nodemailer with SMTP (Any Email Provider)

### Steps:

1. **Install nodemailer**
   ```bash
   npm install nodemailer
   ```

2. **Choose an SMTP provider:**
   - Gmail (free, but limited)
   - SendGrid (free tier: 100 emails/day)
   - Mailgun (free tier: 5,000 emails/month)
   - AWS SES (very cheap)
   - Your own SMTP server

3. **Update `.env` file**
   ```env
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=your-email@gmail.com
   SMTP_PASS=your-app-password
   EMAIL_FROM=your-email@gmail.com
   ```

4. **Update `server.js`** to use nodemailer instead of Resend

**Pros:**
- ✅ Works with any SMTP provider
- ✅ More control
- ✅ Can use existing email infrastructure

---

## Option 3: Supabase Edge Functions (Advanced)

You can create a Supabase Edge Function that sends emails, but it requires more setup.

---

## Option 4: Twilio SendGrid

Twilio owns SendGrid, which is an email service (not SMS).

1. **Sign up for SendGrid**
   - Go to https://sendgrid.com
   - Free tier: 100 emails/day

2. **Get API Key**
   - Create API key in SendGrid dashboard

3. **Use with nodemailer** (SendGrid SMTP) or SendGrid API

---

## Current Implementation

The backend is currently set up to use **Resend** (Option 1), but falls back to console logging if Resend is not configured.

### To enable email sending:

1. Get Resend API key
2. Add to `back/.env`:
   ```env
   RESEND_API_KEY=re_your_key_here
   EMAIL_FROM=noreply@yourdomain.com
   ```
3. Restart backend

### For development/testing:

Without email service configured, verification codes are logged to console. Check your backend terminal for the code.

---

## Recommendation

**Use Resend** - it's the simplest and works great with Supabase. Free tier is perfect for development and small projects.
