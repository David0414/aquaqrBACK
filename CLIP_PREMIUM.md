# Clip y Premium por máquina

## Publicar esta actualización

1. En Supabase, abrir **SQL Editor → New query**, pegar todo
   [ACTUALIZAR_CLIP_PREMIUM.sql](ACTUALIZAR_CLIP_PREMIUM.sql) y ejecutar **Run**.
   Requiere las migraciones anteriores de roles, membresías y monedas. El archivo
   se puede ejecutar nuevamente; conserva los pagos y los precios Premium editados.
2. En las variables **del backend en Railway**, configurar:

   ```env
   CLIP_API_KEY=tu_api_key_de_clip
   CLIP_SECRET_KEY=tu_clave_secreta_de_clip
   APP_PUBLIC_URL=https://tu-app-publicada
   API_PUBLIC_URL=https://aquaqrback-production.up.railway.app
   ```

   También se admite `CLIP_AUTH_TOKEN` con el token Basic completo, en lugar del
   par de claves. Estas credenciales se obtienen en el
   [panel de desarrolladores de Clip](https://developer.clip.mx/reference/token-de-autenticacion).
   Configurarlas solamente en Railway; el frontend usa `VITE_API_URL` y no recibe las claves.
3. Hacer push y publicar ambos proyectos. El backend debe compilar con
   `npm run build` (genera Prisma) e iniciar con `npm start`.
4. Para el **Checkout Redireccionado** utilizado por esta app, configurar
   credenciales de **producción**. Clip no incluye esta API entre las compatibles
   con su [sandbox](https://developer.clip.mx/reference/pruebas).
   Para verificar el flujo, Clip indica hacer una
   [transacción pequeña con una tarjeta bancaria real](https://developer.clip.mx/discuss/646277aa0ef983002b45f89f).
   En esta app se puede elegir un monto personalizado de $10. Es un cobro real;
   las tarjetas de prueba publicadas para Checkout Transparente no aplican aquí.

La migración es `20261012120000_clip_machine_premium_and_benefits`.
Los cambios están preparados para el SQL Editor; no se aplicaron a la base publicada.

## Recarga de clientes

La pantalla 1 permite elegir $50, $100, $200, $500 o un monto de $10 a $500.
La pantalla 2 presenta el saldo a recibir y abre el
[checkout redireccionado de Clip](https://developer.clip.mx/reference/createnewpaymentlink).
Al regresar, el backend consulta el pago: verifica ID, referencia, importe y moneda.
Sólo `CHECKOUT_COMPLETED` acredita el saldo. La URL de regreso no confirma el pago.
Un pago pendiente permite verificar nuevamente o volver a Clip.

El webhook se configura al crear cada enlace:
`POST /api/payments/clip/webhook`. Se procesa la notificación consultando el estado
con Clip; el estado recibido en el cuerpo no autoriza saldo ni Premium.
La recarga y su bono se acreditan en una transacción, una sola vez, incluso si llegan
al mismo tiempo el webhook y la consulta del navegador. Los pagos de Stripe ya
registrados conservan su conciliación; sus credenciales siguen siendo necesarias
si todavía quedan pagos antiguos pendientes.

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
