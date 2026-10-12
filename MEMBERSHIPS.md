# Membresías por consumo y promociones mensuales

Las membresías son paquetes de 5, 8 u 11 garrafones de 20 litros. Se pagan una
vez con el saldo disponible y terminan cuando se consumen sus litros. No tienen
vencimiento mensual ni renovación automática. Al agotarlas, el cliente puede
comprar otro paquete inmediatamente, elegir una promoción o seguir comprando
agua al precio normal. Si un llenado supera los litros restantes, solo se cobra
con saldo la diferencia.

Cashback y recompensa por consumo conservan su cálculo y liquidación mensual.
Sin paquete, el cliente elige cashback o bono por depósito. Con un paquete pagado
conserva cashback y EVA Coins; el paquete reemplaza el bono por depósito hasta
agotar sus litros. EVA Coins es automático e independiente.

## Actualizar Supabase

1. Abre el SQL Editor de tu proyecto Supabase y crea una consulta.
2. Copia y ejecuta **todo** el archivo
   [migration.sql](prisma/migrations/20261006120000_membership_usage_and_machine_coins/migration.sql).
3. Actualiza el backend, ejecuta `npx prisma generate` y reinícialo. Publica también
   los cambios del frontend.

El SQL se puede ejecutar nuevamente. Agrega el control de monedas por máquina,
el identificador de compra y los litros cubiertos por membresía; permite una
fecha de vencimiento vacía. Conserva los litros de las membresías registradas
como activas y elimina su vencimiento por fecha. Las membresías históricas sin
máquina identificable conservan compatibilidad con las máquinas existentes.
Los estados históricos ya cancelados o vencidos no se reactivan.

Si las tablas de membresías todavía no existen en tu Supabase, aplica primero
las migraciones anteriores del proyecto.

## Precios por máquina

El socio puede cambiar el precio de sus máquinas desde **Máquinas**. El cliente
escanea el QR para ver el precio del paquete en esa máquina antes de pagarlo.
La actualización de octubre aplica descuentos de $0.20, $0.30 y $0.40 por
garrafón para paquetes de 5, 8 y 11. Con precio público de $18, cuestan $89,
$141.60 y $193.60. Con otro precio, se resta el descuento a cada garrafón.
Cambiar el precio no modifica los litros de paquetes ya pagados.
El historial muestra la compra del paquete y los llenados cubiertos. Los ingresos
del socio incluyen el pago de la membresía y el agua cobrada aparte, evitando
contar nuevamente como ingreso los litros que ya estaban incluidos.

## Monedas

La pantalla **Recargas** ofrece tarjeta. En **Máquinas**, el administrador puede
editar una máquina, activar **Habilitar monedas** y guardar el cambio. Los socios
pueden consultar ese estado. Las monedas quedan deshabilitadas por defecto.

La aplicación acredita monedas únicamente si la máquina está habilitada y el
cliente tiene una sesión activa en ella después de escanear su QR. El historial
mantiene las recargas por monedas realizadas anteriormente.
Este control autoriza comandos y acreditaciones del backend; no configura el
aceptador físico de monedas. El cierre físico requiere soporte del controlador.

Para la nueva actualización de precios, pagos con Clip y Premium de socios,
consulta [CLIP_PREMIUM.md](CLIP_PREMIUM.md) y aplica su SQL antes de publicar.

## Verificación local

`node --test` ejecuta las pruebas con base de datos, identidades y hardware
simulados. Verifica pago único, reintentos, agotamiento, compra inmediata de otro
paquete, cobertura parcial, aislamiento por máquina y promociones mensuales.
