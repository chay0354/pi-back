# Resend DNS Records Setup for GoDaddy

## 📋 DNS Records to Add in GoDaddy

Based on your Resend dashboard, add these DNS records to your GoDaddy domain:

### 1. DKIM Record (Domain Verification)

**Type:** `TXT`  
**Name:** `resend._domainkey`  
**Data/Value:** (Copy the full content from Resend dashboard - starts with `p=MIGfMAOGCSqGSIb3DQEB...`)  
**TTL:** `1 Hour` (or Auto)

**Example:**
```
Type: TXT
Name: resend._domainkey
Data: p=MIGfMAOGCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC... (full string from Resend)
TTL: 1 Hour
```

---

### 2. SPF Record (Enable Sending)

**Type:** `TXT`  
**Name:** `send`  
**Data/Value:** `v=spf1 include:amazonses.com ~all` (or the exact value from Resend dashboard)  
**TTL:** `1 Hour` (or Auto)

**Example:**
```
Type: TXT
Name: send
Data: v=spf1 include:amazonses.com ~all
TTL: 1 Hour
```

---

### 3. MX Record (Enable Sending)

**Type:** `MX`  
**Name:** `send`  
**Data/Value:** (Copy from Resend - looks like `feedback-smtp.ap-north...`)  
**Priority:** `10`  
**TTL:** `1 Hour` (or Auto)

**Example:**
```
Type: MX
Name: send
Data: feedback-smtp.ap-northeast-1.amazonses.com (or your region from Resend)
Priority: 10
TTL: 1 Hour
```

---

### 4. DMARC Record (Optional - You already have one!)

You already have a DMARC record:
```
Type: TXT
Name: _dmarc
Data: v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;
```

**You can either:**
- Keep your existing DMARC record (it's fine)
- Or update it to match Resend's suggested one: `v=DMARC1; p=none;`

---

## 📝 Step-by-Step Instructions for GoDaddy

1. **Log in to GoDaddy** → Go to your domain management
2. **Click on your domain** (piverification.site)
3. **Go to DNS Management** (or DNS Settings)
4. **Click "Add"** to add each record:

   **For DKIM:**
   - Click "Add"
   - Type: Select `TXT`
   - Name: Enter `resend._domainkey`
   - Value: Paste the full content from Resend dashboard
   - TTL: Select `1 Hour`
   - Click "Save"

   **For SPF:**
   - Click "Add"
   - Type: Select `TXT`
   - Name: Enter `send`
   - Value: Paste from Resend (usually `v=spf1 include:amazonses.com ~all`)
   - TTL: Select `1 Hour`
   - Click "Save"

   **For MX:**
   - Click "Add"
   - Type: Select `MX`
   - Name: Enter `send`
   - Value: Paste the MX value from Resend (e.g., `feedback-smtp.ap-northeast-1.amazonses.com`)
   - Priority: Enter `10`
   - TTL: Select `1 Hour`
   - Click "Save"

5. **Wait for DNS propagation** (can take 5 minutes to 24 hours, usually 1-2 hours)

---

## ✅ After Adding Records

1. **Go back to Resend dashboard**
2. **Click "Verify"** or wait for automatic verification
3. **Once verified**, update your `.env` file:

```env
RESEND_API_KEY=re_your_key_here
EMAIL_FROM=noreply@piverification.site
```

(Replace `piverification.site` with your actual domain)

---

## 🔍 How to Get Exact Values from Resend

1. In Resend dashboard, go to **"Domains"**
2. Click on your domain
3. You'll see the DNS records page with exact values
4. Copy each value exactly as shown

---

## ⚠️ Important Notes

- **Don't delete** your existing `ns`, `soa`, or `cname` records
- **Don't change** your existing `_dmarc` record unless you want to
- DNS changes can take time to propagate (be patient!)
- Make sure to copy the **full** DKIM value - it's very long!

---

## 🧪 Test After Setup

Once DNS is verified in Resend:
1. Restart your backend: `cd back && npm run dev`
2. Try submitting a subscription form
3. Check the email inbox for the verification code
