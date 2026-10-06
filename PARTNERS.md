# Panel de socios y asignación de máquinas

El administrador ve todas las máquinas y todos los socios en `/water-monitor`.
El administrador entra con **usuario y contraseña**, sin correo ni cuenta de
Clerk, y abre `/water-monitor`. El socio entra con su **correo** mediante Clerk
y abre `/partner-panel`; el cliente usa su cuenta habitual y abre
`/home-dashboard`. El botón inferior **Entrar como socio o administrador** abre
un acceso con dos opciones: **Socio** y **Administrador**. Los accesos
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

- `MONITOR_ADMIN_USER` y `MONITOR_ADMIN_PASSWORD`: usuario y contraseña del
  administrador, configurados solamente en el backend. No hay credenciales
  predeterminadas. El formulario valida los datos en `/api/management/login`
  y recibe una sesión firmada que vence a las ocho horas. El navegador conserva
  el token en `sessionStorage`; no guarda la contraseña. Al cerrar sesión lo elimina.
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
5. El socio pulsa **Entrar como socio o administrador**, debajo del acceso habitual,
   elige **Socio** e inicia sesión con su correo. La aplicación abre su panel.
   Para entrar como administrador, elegir **Administrador** e ingresar el usuario
   y la contraseña configurados en el backend. El acceso habitual
   también dirige cada cuenta al panel que corresponde a su rol.

## Configurar el primer administrador

Configurar `MONITOR_ADMIN_USER` y `MONITOR_ADMIN_PASSWORD` en las variables del
servidor y reiniciar el backend. El acceso por usuario y contraseña no necesita
crear un usuario administrador en Supabase ni registrar un correo en Clerk.
La migración de socios y propietarios descrita arriba sí debe estar aplicada.

No hay cambios adicionales de esquema para separar los accesos. Las cuentas nuevas
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

Los cambios de membresías por consumo y control de monedas requieren otra
actualización en Supabase. Consulta [MEMBERSHIPS.md](MEMBERSHIPS.md) para pegar
el SQL y configurar cada máquina.

```powershell
node --test
```

Las pruebas de gestión utilizan cuentas, base de datos y autenticación simuladas;
comprueban el aislamiento entre socios, la suspensión, transferencias, controles,
calibración, validación de identidad y sesiones administrativas. No envían órdenes
a una máquina física ni modifican la base de datos del entorno.
