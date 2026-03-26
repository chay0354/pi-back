-- Add project_name to ads: top field in property address form (name of project).
-- address remains the bottom field (project address).

ALTER TABLE ads ADD COLUMN IF NOT EXISTS project_name TEXT NULL;

COMMENT ON COLUMN ads.project_name IS 'Name of the project (שם הפרויקט). Top field in property address form.';
COMMENT ON COLUMN ads.address IS 'Project/location address (כתובת הפרויקט). Bottom field in property address form.';
