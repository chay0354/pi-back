# Backend Setup Instructions

## 1. Environment Variables

Update the `.env` file in the `back` directory with the following:

```env
# Supabase Configuration
SUPABASE_URL=https://opxeruasowoaybceskyp.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here

# Server Configuration
PORT=3000
```

**Important:** You need to get your Supabase Service Role Key from:
1. Go to your Supabase project dashboard
2. Navigate to Settings > API
3. Copy the "service_role" key (keep this secret!)

## 2. Database Setup

Run the SQL schema in `database-schema.sql` in your Supabase SQL Editor:

1. Go to Supabase Dashboard > SQL Editor
2. Copy and paste the contents of `database-schema.sql`
3. Execute the SQL to create the `subscriptions` table

## 3. Storage Bucket Setup

Create a storage bucket in Supabase for user uploads:

1. Go to Supabase Dashboard > Storage
2. Click "New bucket"
3. Name: `user-uploads`
4. Public: Yes (or configure policies as needed)
5. File size limit: 50 MB (or as needed)
6. Allowed MIME types: Any (or restrict as needed)

### Storage Folder Structure:
- `profiles/` - Profile pictures
- `additional/` - Additional images
- `logos/` - Company logos
- `videos/` - Video files
- `general/` - Other files

## 4. Install Dependencies

```bash
cd back
npm install
```

## 5. Start the Server

Development (with auto-reload):
```bash
npm run dev
```

Production:
```bash
npm start
```

The server will run on `http://localhost:3000`

## 6. Test the API

Health check:
```bash
curl http://localhost:3000/health
```

## API Endpoints

### Subscription Endpoints

- `POST /api/subscription/submit` - Submit subscription form
- `POST /api/subscription/verify` - Verify email with code
- `POST /api/subscription/resend-code` - Resend verification code
- `GET /api/subscription/:id` - Get subscription by ID

### File Upload Endpoints

- `POST /api/upload` - Upload a single file

## Notes

- The verification code is currently logged to console (remove in production)
- Email sending is not implemented (TODO: integrate email service)
- File uploads use Supabase Storage
- All subscription types (broker, company, professional) are supported
