-- Pegar el archivo completo en Supabase > SQL Editor > New query > Run.
BEGIN;

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

-- Acceso solicitado: usuario administrador / contraseña 123.
-- Ejecutar también este archivo para restablecer esa contraseña.
INSERT INTO public."User" ("id", "name", "role", "managementAccessActive")
VALUES (COALESCE((SELECT "userId" FROM public."AdminCredential" WHERE "username" = 'administrador'), 'admin_administrador'),
        'Administrador', 'ADMIN', true)
ON CONFLICT ("id") DO UPDATE SET "role" = 'ADMIN', "managementAccessActive" = true;

INSERT INTO public."AdminCredential" ("username", "userId", "passwordHash")
VALUES ('administrador', COALESCE((SELECT "userId" FROM public."AdminCredential" WHERE "username" = 'administrador'), 'admin_administrador'),
        'scrypt$c6d5e0b32aa1828a909e43664f0f5d16$22003386c6f689dc5b015b86de6fdf76ed32ee24131a942238a844e3d9b99fbc910e10b2acb0d7887e85818239b7cfb77389f698b59170bfdc73ea708944e9fb')
ON CONFLICT ("username") DO UPDATE SET "passwordHash" = EXCLUDED."passwordHash";

SELECT a."username" AS usuario, u."role" AS rol, u."managementAccessActive" AS activo
FROM public."AdminCredential" a JOIN public."User" u ON u."id" = a."userId"
WHERE a."username" = 'administrador';

COMMIT;
