# Clip Transparente, pruebas y Premium por máquina

## Publicar esta actualización

1. Si ya ejecutaste [ACTUALIZAR_CLIP_PREMIUM.sql](ACTUALIZAR_CLIP_PREMIUM.sql),
   ahora abrir **SQL Editor → New query**, pegar
   [ACTUALIZAR_CLIP_TRANSPARENTE.sql](ACTUALIZAR_CLIP_TRANSPARENTE.sql) y ejecutar **Run**.
   Para una instalación nueva, ejecutar primero el SQL Premium y después el SQL
   Transparente. Requiere las migraciones anteriores de roles, membresías y monedas.
   Los archivos se pueden ejecutar nuevamente y conservan los pagos anteriores.
2. En las variables **del backend en Railway**, configurar:

   ```env
   CLIP_API_KEY=test_tu_clave_api_de_pruebas
   APP_PUBLIC_URL=https://tu-app-publicada
   API_PUBLIC_URL=https://aquaqrback-production.up.railway.app
   ```

   Pegar la Clave API completa de **Pruebas**, tal como la entrega Clip; debe
   empezar con `test_`. No agregar `Basic`, comillas ni inventar una clave.
   Se obtiene en **Panel de desarrolladores → Credenciales → Crear credencial → Pruebas**.
   El backend usa `Bearer` automáticamente. Checkout Transparente no necesita
   `CLIP_SECRET_KEY` ni `CLIP_AUTH_TOKEN`; esas variables sólo se conservan para
   conciliar enlaces antiguos de Checkout Redireccionado.
   No hace falta agregar una variable Clip a Vercel: el frontend obtiene del
   backend autenticado la **Clave API pública requerida por el SDK**. La clave
   secreta y el token Basic nunca se envían al navegador.
   Conservar `APP_BASE_URL`, las variables de Supabase/Clerk y los comandos que ya funcionan.
3. Hacer push y publicar ambos proyectos. El backend debe compilar con
   `npm run build` (genera Prisma) e iniciar con `npm start`.
4. Aplicar las variables con **Deploy** en Railway y probar una recarga con una
   tarjeta oficial de sandbox. La pantalla mostrará **Modo de prueba · sin cargos reales**.

## Si aparece «Not Found» donde va la tarjeta

El formulario pide su configuración al backend en
`GET /api/payments/clip/config`. Si esa petición devuelve **404 / Not Found**,
Railway todavía está ejecutando una versión que no incluye esta ruta.
Cambiar las claves de Clip o ejecutar SQL no agrega las rutas del backend.

1. Guardar los cambios, hacer **commit y push del proyecto Backend**, incluyendo
   los archivos nuevos. Esta actualización necesita tanto
   `src/routes/clipWebhook.js` como `src/utils/clipTransparent.js` y el resto de
   los cambios de Checkout Transparente.
2. En Railway, abrir el servicio **aquaqrBACK → Deployments** y comprobar que
   el nuevo despliegue corresponde al commit recién enviado y termina correctamente.
   Si Railway no publica automáticamente, desplegar el último commit de la rama
   conectada. Volver a desplegar un commit anterior conserva el error.
3. Publicar también el frontend actualizado en Vercel y recargar la app.
   Ante un fallo ahora muestra el motivo, detiene «Cargando…» y permite
   **Reintentar cargar formulario**, sin iniciar otro pago.

Para comprobar que la ruta ya existe, abrir en el navegador
`https://aquaqrback-production.up.railway.app/api/payments/clip/config`
sin iniciar sesión. Debe responder **401 (requiere autenticación)**, en vez de
404. Dentro de la app, con sesión iniciada y la clave Clip configurada, debe
responder **200**. Un **503** con el mensaje de que falta configurar la Clave API
se resuelve revisando `CLIP_API_KEY` en las variables del servicio backend y
aplicando el despliegue.

## Tarjetas y entorno de pruebas

La app ahora usa el [SDK de Checkout Transparente](https://developer.clip.mx/reference/configuracion-del-sdk-de-checkout-transparente)
y la API `POST /payments`, ambos compatibles con el
[sandbox oficial de Clip](https://developer.clip.mx/reference/pruebas).

Datos para un pago aprobado de prueba:

| Campo | Valor |
| --- | --- |
| Número de tarjeta | `4555128482797669` (Visa BBVA, México) |
| Vencimiento | Una fecha futura, por ejemplo `12/30` |
| CVV | `123` |
| Nombre | Tu nombre o un nombre de prueba |

Para simular fondos insuficientes: `4555126387272952`.
Ingresar también correo y teléfono de 10 dígitos en la app. Las tarjetas
American Express necesitan dirección de facturación; usar el apartado desplegable.
La tarjeta `4242…` de Stripe no sirve para Clip.

El SDK alojado por Clip captura la tarjeta en su iframe y entrega un token de
un solo uso. Nuestro backend recibe el token, el correo y el teléfono; nunca
recibe ni guarda el número completo, vencimiento ni CVV.

Sandbox simula el saldo, el bono y Premium **en la base de datos configurada**.
Usar una base y un despliegue de pruebas para mantener esos saldos separados de
los clientes reales. Cambiar a una clave de producción no borra saldos simulados.
Premium registra el entorno y una activación sandbox no habilita estadísticas
cuando se vuelve a usar producción.

Para cobrar dinero real, reemplazar `CLIP_API_KEY` por la Clave API de
**Producción**, aplicar **Deploy** y recargar la app. El aviso de pruebas desaparece.
Clip puede requerir verificar la identidad del negocio para habilitar su SDK.

La migración Premium es `20261012120000_clip_machine_premium_and_benefits`;
la nueva migración es `20261012180000_clip_transparent_checkout`.
El nuevo SQL Transparente está preparado para el SQL Editor; no se aplicó a la base publicada.

## Recarga de clientes

El botón muestra **Pagar** en ambos entornos. Con una clave `test_`, el aviso
**Modo de prueba · sin cargos reales** permanece visible: cambiar el texto del
botón no convierte las credenciales en productivas.

Un pago `approved` verificado suma el importe a **Saldo depositado** y el bono
correspondiente a **Saldo de promociones**, una sola vez. Al volver a Inicio se
presenta inmediatamente el saldo confirmado; una consulta anterior todavía en
curso no puede reemplazarlo por el saldo viejo. Si el webhook confirma primero,
la respuesta del pago también devuelve la cartera actualizada.

La aprobación recibida en `POST /payments` se valida y se utiliza en esa misma
solicitud. Los pagos pendientes se siguen verificando con consultas nuevas a
Clip y se acreditan al aprobarse. Promociones comparte el último resumen de cada
usuario, actualiza los datos en segundo plano y consulta precios vigentes antes
de comprar. El catálogo se inicializa una vez por proceso, conservando la lectura
de los cambios de precios y promociones del administrador.

Esta corrección no añade columnas ni requiere otro SQL. Publicar los cambios de
Backend en Railway y del frontend en Vercel, incluyendo los archivos nuevos.

La pantalla 1 permite elegir $50, $100, $200, $500 o un monto de $10 a $500.
La pantalla 2 presenta el saldo a recibir y el formulario protegido de Clip
dentro de la app. El backend fija el importe y el bono antes de recibir el token.
Consulta `GET /payments/{id}` y verifica ID, referencia, importe y moneda.
Sólo un pago `approved`, sin reembolso ni propina, acredita el saldo.
Un pago `pending` o `authorized` no agrega saldo ni activa Premium.
Si el banco exige 3DS, se abre su validación y se consulta de nuevo el estado en
el backend. También hay un botón para verificar y consultas periódicas mientras
el pago está pendiente.

El backend envía `webhook_url` al crear el pago, con la ruta
`POST /api/payments/clip/transparent/webhook?payment=ID_LOCAL`.
No hace falta activar **Postback Webhooks** en el panel de Clip.
Toda notificación se verifica consultando a Clip; el estado recibido en su cuerpo
no autoriza saldo ni Premium. Si llega antes de guardarse el ID remoto, el backend
lo recupera únicamente cuando la referencia, moneda e importe coinciden.
La recarga y su bono se acreditan en una transacción una sola vez.
Un doble clic reutiliza la misma solicitud; una respuesta incierta bloquea el
intento y permite verificar, sin volver a enviar un cargo. Si no se recibe ni ID
de pago ni notificación, requiere revisar ese pago en Clip antes de otro intento.

Los enlaces Clip anteriores conservan su consulta `/v2/checkout` y su webhook
`/api/payments/clip/webhook`; los pagos Stripe ya registrados conservan su
conciliación. Las credenciales correspondientes siguen siendo necesarias para
esos pagos pendientes. Los pagos nuevos usan exclusivamente Clip Transparente.

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
