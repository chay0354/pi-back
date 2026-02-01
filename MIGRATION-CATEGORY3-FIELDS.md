# Migration: Add Category 3 Fields to Listings Table

This migration adds the new fields required for category 3 (חדש מקבלן - New from contractor) listings.

## Steps to Apply

1. **Open Supabase SQL Editor**
   - Go to your Supabase project dashboard
   - Navigate to SQL Editor

2. **Run the Migration**
   - Copy the contents of `migration-add-category3-fields.sql`
   - Paste into the SQL Editor
   - Click "Run" to execute

## What This Migration Does

### New Columns Added:
- `search_purpose` (VARCHAR) - מטרת החיפוש: 'enter', 'bring_in', 'partner'
- `preferred_apartment_type` (VARCHAR) - סוג דירת השותפים המועדף: 'regular', 'studio', 'garden', 'duplex', 'penthouse', 'private'
- `preferred_gender` (VARCHAR) - מין מועדף: 'female', 'male'
- `preferred_age_min` (INTEGER) - גיל מינימלי מועדף (18-100)
- `preferred_age_max` (INTEGER) - גיל מקסימלי מועדף (18-100)
- `preferences` (JSONB) - העדפות (checkboxes): {"nonSmokers": true, "students": false, ...}
- `budget` (DECIMAL) - התקציב

### Schema Changes:
- Made `address` and `phone` nullable (not required for category 3)
- Added indexes for efficient filtering by category 3 fields

## Backend Updates

The backend (`server.js`) has been updated to:
- Accept the new category 3 fields in the POST `/api/listings` endpoint
- Validate fields differently based on category (category 3 has different required fields)
- Insert the new fields into the database when creating category 3 listings

## Frontend Integration

The frontend already sends these fields when creating a category 3 listing:
- `searchPurpose`
- `preferredApartmentType`
- `preferredGender`
- `preferredAgeMin`
- `preferredAgeMax`
- `preferences`
- `budget`

## Verification

After running the migration, verify the columns were added:
```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'listings'
AND column_name IN (
  'search_purpose',
  'preferred_apartment_type',
  'preferred_gender',
  'preferred_age_min',
  'preferred_age_max',
  'preferences',
  'budget'
);
```
