# Paneles por máquina

El socio entra en **Mis máquinas** y abre la ficha de la máquina que desea administrar. Cada ficha muestra su nombre, ubicación, conexión y estado Premium.

- **Controles:** bomba, llenado, enjuague, apagado general y reinicio. El desfase se introduce en mililitros; se conserva la conversión y el protocolo existentes.
- **Premium y estadísticas:** precio calculado para esa máquina, vigencia, pago con Clip y estadísticas cuando tiene acceso. El administrador consulta estadísticas sin comprar Premium.
- **Datos y precio:** nombre, dirección, precio por 20 litros y disponibilidad. Solo el administrador cambia el controlador y la aceptación de monedas.
- **Código QR:** generación y descarga del código exclusivo de la máquina abierta.
- **Socio responsable:** solo para administración; asignación, cambio de socio o retiro de la asignación.

El administrador también tiene el directorio de **Socios**, el alta de máquinas, las **Tarifas Premium** generales por volumen y las **Promociones** para clientes. Eliminar una máquina requiere confirmación; el backend conserva la protección de las máquinas con historial de pagos.

Las tarjetas consultan el estado Premium con una lectura conjunta de los pagos vigentes, limitada a las máquinas autorizadas. Los pagos de pruebas y producción mantienen su separación. Los comandos, calibración, precios y QR conservan sus endpoints y comprobaciones de permisos.

Publicar **Backend en Railway** y **aquaqr en Vercel**, incluyendo los archivos nuevos. Este rediseño no agrega columnas ni requiere otro SQL en Supabase.

La maqueta utiliza CSS 3D, muestra el identificador de cada máquina y permite cambiar a una vista frontal. Las transiciones respetan la preferencia del dispositivo para reducir movimiento. Los formularios y las vistas se adaptan a celular, computadora y tema oscuro.
