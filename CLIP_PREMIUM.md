# Pagos Clip y Premium por máquina

## Flujo actual sin correo ni teléfono en AquaQR

Las recargas nuevas y las membresías Premium abren el **Checkout Redireccionado de Clip**.
La app no pide ni envía correo o teléfono para iniciar el pago. Clip recibe al cliente
en su página segura y la app concilia el resultado antes de acreditar saldo o activar
Premium. Volver a AquaQR no acredita el pago por sí solo: el backend verifica estado,
importe y referencia.

En Railway, este flujo requiere las credenciales Basic de Clip:

```env
CLIP_API_KEY=test_tu_clave_api
CLIP_SECRET_KEY=tu_clave_secreta
APP_PUBLIC_URL=https://tu-app-publicada
API_PUBLIC_URL=https://aquaqrback-production.up.railway.app
```

Usa la API key y la clave secreta del mismo entorno (Pruebas o Producción). Si Clip
te entregó un token Basic completo, puedes ponerlo en `CLIP_AUTH_TOKEN` en lugar de
las otras dos variables. Mantén las claves privadas solo en Railway, nunca en Vercel.
No necesitas configurar Postback Webhooks manualmente; el backend envía la URL al
crear cada checkout.

La página alojada y los campos que Clip muestre ahí los controla Clip. AquaQR omite
`metadata.customer_info`, que Clip documenta como [opcional](https://developer.clip.mx/reference/introduccion-a-clip-checkout);
no inventa datos de contacto ni bloquea el inicio del pago por el perfil del usuario.

## Publicar la versión actual

Este cambio no requiere ejecutar SQL. Publica los cambios del frontend en Vercel y
los cambios de Backend en Railway. En Railway configura las credenciales Basic
que Clip entrega para el mismo entorno:

```env
CLIP_API_KEY=test_tu_clave_api
CLIP_SECRET_KEY=tu_clave_secreta
APP_PUBLIC_URL=https://tu-app-publicada
API_PUBLIC_URL=https://aquaqrback-production.up.railway.app
```

También se puede usar `CLIP_AUTH_TOKEN` si Clip entregó el token Basic completo,
en lugar de `CLIP_API_KEY` y `CLIP_SECRET_KEY`. Conserva las credenciales privadas
solo en Railway. Con claves de Pruebas no se cobra dinero real; para cobrar de verdad
se deben poner las credenciales de Producción del mismo comercio y volver a desplegar.

La app ya no carga el formulario incrustado ni exige correo o teléfono del perfil.
El botón **Pagar** crea un checkout alojado por Clip y redirige al cliente. AquaQR
omite `metadata.customer_info` (opcional según Clip); la página alojada y cualquier
campo adicional que Clip muestre los controla Clip. No agregues datos inventados.
No hace falta configurar Postback Webhooks manualmente: el backend incluye su
webhook al crear el checkout, verifica el resultado y acredita la recarga o activa
Premium una sola vez.

Si después del despliegue todavía aparece el formulario anterior, actualiza el
frontend en Vercel y el Backend en Railway. No ejecutes SQL para corregirlo.

## Entorno de pruebas

Prueba usando credenciales de **Pruebas** y la tarjeta indicada actualmente en el
panel/documentación de Clip para Checkout Redireccionado. La tarjeta `4242…` de
Stripe no sirve para Clip. Los pagos de prueba solo actualizan la base de datos
configurada; usa una base de pruebas si no quieres mezclar saldos con clientes reales.

La migración Premium es `20261012120000_clip_machine_premium_and_benefits`;
la migración Transparente anterior es `20261012180000_clip_transparent_checkout`.
No se requiere una nueva migración para el flujo redireccionado ni para quitar los
campos de correo/teléfono de la pantalla AquaQR.

## Recarga de clientes

La pantalla de monto conserva los importes de $50, $100, $200, $500 y el monto
personalizado de $10 a $500. En el paso de pago se muestra el saldo a recibir y un
solo botón **Pagar**. Tras la aprobación, el backend suma el importe a **Saldo depositado**
y el bono correspondiente a **Saldo de promociones**, una sola vez.
Al volver a Inicio se presenta el saldo confirmado. Un pago pendiente no acredita
saldo hasta que Clip confirme el estado.
## Premium de socios

El acceso normal permite controlar y ajustar el desfase de las máquinas asignadas.
**Estadísticas / Premium** funciona por máquina. Los precios iniciales siguen la
tabla suministrada:

| Garrafones equivalentes por mes | Segmento | Precio mensual MXN |
| --- | --- | ---: |
| 0–100 | Básico | $271 |
| 101–150 | Básico+ | $330 |
| 151–250 | Intermedio | $449 |
| 251–350 | Intermedio+ | $569 |
| 351–500 | Avanzado | $748 |
| 501–600 | Avanzado+ | $867 |
| 601+ | Premium | $986 |

El volumen es la suma de litros de dispensados `COMPLETED` registrados para esa
máquina durante el **último mes calendario completo, hora de Ciudad de México**,
dividida entre 20. Los llenados de 5 y 10 L cuentan proporcionalmente; un volumen
fraccionario que supera el máximo de un rango pasa al siguiente. Una máquina nueva
sin ventas registradas toma Básico. El costo operativo y el margen de la tabla son
referencias comerciales; el cobro usa la columna de membresía sugerida.

El socio revisa el importe y paga con Clip. Al confirmar el pago se activa un mes
calendario desde la confirmación. La renovación es manual y agrega un mes a la
vigencia existente si se paga antes de vencer. El acceso pagado pertenece a la
máquina; una transferencia de propietario conserva su vigencia.

El administrador puede consultar estadísticas de todas las máquinas y modificar
los precios de los siete rangos. Los socios sólo consultan las estadísticas de
sus máquinas con Premium vigente. La autorización se verifica en el backend,
incluida la ruta de estadísticas; el resumen normal no contiene ventas de socios.
Los ingresos Premium quedan en `MachinePremiumPayment` y no acreditan saldo de agua.

## Beneficios de clientes

Estos paquetes de agua son independientes del Premium de la máquina:

- Sin paquete, se elige **Cashback o Bono por depósito**. EVA Coins siempre aplica.
- Con paquete de agua, se conserva cashback y EVA Coins, y se reemplaza el bono
  por depósito mientras queden litros. Cashback sigue liquidándose por mes.
- Bonos por depósito: 2.5% desde $100, 3.5% desde $200 y 4.5% con $500. Los montos
  personalizados usan el porcentaje del rango, redondeado a centavos.
- Los paquetes de 5, 8 y 11 garrafones descuentan $0.20, $0.30 y $0.40 por garrafón.
  Con precio base $18, cuestan $89, $141.60 y $193.60. El cálculo toma el precio
  guardado en cada máquina. Los paquetes ya pagados conservan sus litros e importe;
  siguen vigentes hasta agotarse.
- EVA Coins: 200 puntos/20 garrafones → $10, 500/50 → $20, 1,000/100 → $30.

## Desfase y stickers

La interfaz expresa el ajuste en **ml por garrafón de 20 L**. Positivo agrega agua;
negativo reduce. Se convierte internamente al valor de pulsos ya utilizado por el
controlador: `base × (1 + desfase / 20,000)`. Se redondea a su resolución entera y
se muestra el ajuste realmente guardado. El protocolo de control y dispensado
sigue utilizando pulsos. El ajuste para 5 y 10 L es proporcional.

El sticker se genera con el QR firmado de la máquina seleccionada. Cambiar de
máquina elimina el QR mostrado anteriormente. No se usa AQ-001 como reemplazo.

## Verificación

`node --test` verifica permisos, rangos, vencimientos, crédito único, rechazo de
importes alterados, rollback y reglas de beneficios con datos simulados. No realiza
cobros ni envía órdenes a hardware real.
