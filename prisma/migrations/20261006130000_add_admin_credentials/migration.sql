-- Password credentials are separate from customer profiles and inaccessible to browser roles.
CREATE TABLE IF NOT EXISTS public."AdminCredential" (
    "username" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    CONSTRAINT "AdminCredential_pkey" PRIMARY KEY ("username"),
    CONSTRAINT "AdminCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "AdminCredential_userId_key" ON public."AdminCredential"("userId");
ALTER TABLE public."AdminCredential" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE public."AdminCredential" FROM anon;
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE public."AdminCredential" FROM authenticated;
    END IF;
END $$;
