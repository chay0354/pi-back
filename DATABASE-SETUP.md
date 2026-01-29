# Database Setup Instructions

## Quick Setup for All 3 User Types

The database needs to support 3 different subscription types:
- **Broker** (מתווך)
- **Company** (חברה)
- **Professional** (בעל מקצוע)

## Step 1: Run the Migration

1. Go to your Supabase Dashboard: https://supabase.com/dashboard
2. Select your project
3. Go to **SQL Editor** (left sidebar)
4. Click **New Query**
5. Copy and paste the following SQL:

```sql
-- Add broker-specific columns if they don't exist
ALTER TABLE subscriptions 
ADD COLUMN IF NOT EXISTS brokerage_license_number VARCHAR(100),
ADD COLUMN IF NOT EXISTS broker_office_name VARCHAR(255);
```

6. Click **Run** (or press Ctrl+Enter)

## Step 2: Verify the Schema

Run this query to verify all columns exist:

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns 
WHERE table_name = 'subscriptions' 
ORDER BY ordinal_position;
```

You should see these columns:
- ✅ `subscription_type` (VARCHAR) - Stores 'broker', 'company', or 'professional'
- ✅ `brokerage_license_number` (VARCHAR) - For broker subscriptions
- ✅ `broker_office_name` (VARCHAR) - For broker subscriptions
- ✅ `types` (JSONB) - For professional subscriptions
- ✅ `specializations` (JSONB) - For professional subscriptions
- ✅ `activity_regions` (JSONB) - For broker subscriptions
- ✅ All company fields (company_id, contact_person_name, etc.)

## Step 3: Complete Database Schema

If you need to create the table from scratch, use the full schema in `database-schema.sql`:

```sql
-- Create subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  subscription_type VARCHAR(20) NOT NULL CHECK (subscription_type IN ('broker', 'company', 'professional')),
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  name VARCHAR(255),
  business_name VARCHAR(255),
  business_address TEXT,
  brokerage_license_number VARCHAR(100), -- For broker subscriptions
  broker_office_name VARCHAR(255), -- For broker subscriptions
  dealer_number VARCHAR(100),
  company_id VARCHAR(100),
  contact_person_name VARCHAR(255),
  office_phone VARCHAR(50),
  mobile_phone VARCHAR(50),
  company_website VARCHAR(255),
  description TEXT,
  types JSONB, -- For professional subscriptions
  specializations JSONB, -- For professional subscriptions
  activity_regions JSONB, -- For broker subscriptions
  profile_picture_url TEXT,
  additional_images_urls JSONB,
  company_logo_url TEXT,
  video_url TEXT,
  verification_code VARCHAR(6),
  verification_code_expires_at TIMESTAMP,
  subscriber_number VARCHAR(20) UNIQUE,
  agreed_to_terms BOOLEAN DEFAULT false,
  status VARCHAR(20) DEFAULT 'pending_verification' CHECK (status IN ('pending_verification', 'verified', 'active', 'suspended')),
  verified_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_subscriptions_email ON subscriptions(email);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_type ON subscriptions(subscription_type);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger to automatically update updated_at
CREATE TRIGGER update_subscriptions_updated_at BEFORE UPDATE ON subscriptions
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

## Field Mapping by Subscription Type

### Broker (מתווך)
- `subscription_type` = 'broker'
- `name` = agent name (שם הסוכן)
- `brokerage_license_number` = מספר רשיון תיווך
- `broker_office_name` = שם משרד המתווך
- `activity_regions` = JSON array of selected regions
- `dealer_number` = מספר עוסק פטור (optional)
- `phone` = מספר טלפון
- `email` = כתובת מייל
- `description` = תיאור (optional)

### Company (חברה)
- `subscription_type` = 'company'
- `business_name` = שם החברה
- `contact_person_name` = שם איש קשר
- `company_id` = מספר עוסק / ח.פ
- `office_phone` = מספר טלפון משרד
- `mobile_phone` = מספר נייד
- `email` = כתובת מייל
- `company_website` = כתובת אתר החברה
- `description` = תיאור (optional)

### Professional (בעל מקצוע)
- `subscription_type` = 'professional'
- `name` = agent name
- `business_name` = שם העסק
- `business_address` = כתובת בית העסק
- `types` = JSON array of selected types (סוג)
- `specializations` = JSON array of selected specializations (התמחות)
- `dealer_number` = מספר עוסק / ח.פ (optional)
- `phone` = מספר טלפון
- `email` = כתובת מייל
- `description` = תיאור (optional)

## Troubleshooting

### Error: "Could not find the 'broker_office_name' column"
**Solution:** Run the migration SQL above to add the missing columns.

### Error: "Invalid API key"
**Solution:** Get your service role key from Supabase Dashboard > Settings > API and add it to `back/.env` as `SUPABASE_SERVICE_ROLE_KEY`

### Error: "Column already exists"
**Solution:** The columns already exist, you can ignore this error. The `IF NOT EXISTS` clause prevents errors if columns already exist.

## Verification

After running the migration, test by submitting a form for each subscription type:
1. Broker subscription - should save with `brokerage_license_number` and `broker_office_name`
2. Company subscription - should save with company fields
3. Professional subscription - should save with `types` and `specializations`

All should have `subscription_type` correctly set to 'broker', 'company', or 'professional'.
