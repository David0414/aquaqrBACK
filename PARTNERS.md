# Panel de socios y asignación de máquinas

El administrador ve todas las máquinas y todos los socios en `/water-monitor`.
Todas las cuentas usan el mismo formulario de Clerk. Al iniciar sesión, el rol
guardado en la base de datos determina el panel: `ADMIN` abre `/water-monitor`,
`PARTNER` abre `/partner-panel` y `CUSTOMER` abre `/home-dashboard`. Los accesos
directos a otros paneles redirigen al panel de la cuenta. Cada socio administra las
máquinas que tiene asignadas. Una cuenta de cliente no tiene permisos de gestión.
Las comprobaciones de rol, suspensión y propiedad se hacen en el backend en cada
petición; cambiar una URL o enviar otro hardware no concede acceso.

## Activación

Desde `Backend`, con las variables de conexión de la base de datos configuradas:

```powershell
npx prisma migrate deploy
npx prisma generate
```

Desplegar/reiniciar el backend y publicar la nueva compilación del frontend después
de aplicar la migración. La migración agrega roles y propietarios; los usuarios
existentes quedan como clientes y las máquinas existentes quedan sin socio.
También normaliza los identificadores hexadecimales de hardware a dos caracteres.

Variables del backend para el acceso administrativo:

- El administrador también debe tener una cuenta de Clerk. Ya no hay un formulario
  separado de acceso administrativo ni botones para elegir el tipo de usuario.
- `MONITOR_ADMIN_USER` y `MONITOR_ADMIN_PASSWORD`: se mantienen únicamente para
  compatibilidad del backend con el acceso administrativo anterior. El frontend
  utiliza la identidad y el rol de la cuenta autenticada.
- `ADMIN_CLERK_USER_IDS` (opcional): IDs de Clerk separados por comas para cuentas
  que deben ser administradoras. Esas cuentas pueden entrar con el acceso habitual.
- `CLERK_SECRET_KEY`: necesaria para verificar la identidad de la cuenta del socio
  al habilitar acceso por correo.

El frontend conserva `VITE_API_URL`. Los roles no requieren claims adicionales en
el token: se consultan en la base de datos. El acceso habitual sigue usando el
template JWT `aquaqr-api` que ya utilizaba la aplicación.

## Dar acceso y asignar una máquina

1. El socio crea su cuenta en la aplicación y verifica su correo.
2. El administrador entra al panel y abre **Socios**.
3. Ingresa el correo verificado y pulsa **Habilitar acceso de socio**.
4. Selecciona una máquina registrada y el socio responsable; pulsa
   **Guardar asignación**. Si la máquina solo se detectó por un sticker, primero
   debe registrarla en **Máquinas** con su identificador de hardware.
5. El socio inicia sesión en el mismo formulario que todos los usuarios y la
   aplicación abre automáticamente su panel.

## Asignar la primera cuenta administradora desde Supabase

La migración deja los usuarios existentes como clientes. Para que la cuenta del
administrador pueda usar el acceso único, debe tener `role = 'ADMIN'`. Se puede
configurar `ADMIN_CLERK_USER_IDS` o actualizar la cuenta en el SQL Editor de
Supabase. Copiar el ID real de esa cuenta desde Clerk y sustituir el ejemplo:

```sql
INSERT INTO public."User" ("id", "clerkId", "role", "managementAccessActive")
VALUES ('user_ID_REAL_DEL_ADMIN', 'user_ID_REAL_DEL_ADMIN', 'ADMIN', true)
ON CONFLICT ("id") DO UPDATE
SET "role" = 'ADMIN', "managementAccessActive" = true;
```

No hay cambios adicionales de esquema para el acceso único. Las cuentas nuevas
continúan siendo clientes; solo un administrador puede habilitarlas como socios.

Un socio puede tener varias máquinas; cada máquina tiene un solo socio responsable.
El administrador puede transferir la máquina, retirar su asignación y suspender o
reactivar al socio. La suspensión conserva las asignaciones y bloquea las
peticiones de gestión incluso si la sesión del socio estaba abierta.

El socio puede editar nombre, ubicación, dirección, precio, estado y activación;
consultar telemetría y ventas registradas de los últimos treinta días; generar el
QR; guardar calibración y usar los controles de sus máquinas. El registro y
eliminación de máquinas, cambios de hardware, asignación de propietarios y
promociones globales corresponden al administrador.

No se permite asignar a dos socios distintos catálogos que apunten al mismo
hardware. Los controles se resuelven con el hardware guardado en la máquina,
en lugar de confiar en el que envíe el navegador.

## Verificación

```powershell
node --test
```

Las pruebas de gestión utilizan cuentas, base de datos y autenticación simuladas;
comprueban el aislamiento entre socios, la suspensión, transferencias, controles,
calibración, validación de identidad y sesiones administrativas. No envían órdenes
a una máquina física ni modifican la base de datos del entorno.
