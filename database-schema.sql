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
  types JSONB,
  specializations JSONB,
  activity_regions JSONB,
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

-- Create index on email for faster lookups
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
