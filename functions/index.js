const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const serviceAccount = require("./gcloud/serviceAccount.json");
const firestore = require("firebase-admin/firestore");
const nodemailer = require('nodemailer');

admin.initializeApp(serviceAccount);

// Configurar el transporter (esto iría después de admin.initializeApp)
const transporter = nodemailer.createTransport({
  service: 'gmail', // o configura tu propio SMTP
  auth: {
    user: 'mati.iribarren98@gmail.com',
    pass: 'iebr shjr njbj udlz' // Se recomienda usar una "app password"
  }
});

const bearerTokenMercadoPago = 'Bearer APP_USR-824237712820488-120716-9c70df22ad7c04e358cfdc4e7a076960-439285460';

exports.processOrder = onRequest(async (request, response) => {
  try {
    console.log('Iniciando procesamiento de orden:', request.body);

    if (!request.body) {
      console.error('Solicitud inválida:', request.body);
      return response.status(400).send({ error: 'Solicitud inválida.' });
    }

    const paymentId = request.body.data.id;

    // Obtener el pago desde mercadopago
    const result = await (await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': bearerTokenMercadoPago
      }
    })).json();
    
    const externalReference = result.external_reference;
    const db = firestore.getFirestore();

    // Buscar la orden en Firestore
    const ordersQuery = await db.collection('orders')
      .where('reference', '==', externalReference)
      .limit(1)
      .get();

    if (ordersQuery.empty) {
      console.error('Orden no encontrada:', externalReference);
      return response.status(404).send({ error: 'Orden no encontrada.' });
    }

    const orderDoc = ordersQuery.docs[0];
    const order = {
      id: orderDoc.id,
      ...orderDoc.data()
    };

    // Actualizar información de pago
    await db.collection('orders').doc(order.id).update({
      status: result.status,
      paymentInformation: {
        paymentId: result.id,
        status: result.status,
        paymentDate: result.date_approved,
        paymentMethod: result.payment_method_id,
        paymentType: result.transaction_amount,
      },
      updatedAt: firestore.FieldValue.serverTimestamp()
    });

    if (result.status === 'approved') {
      // Procesar actualización de stock
      const stockUpdates = order.products.map(async (product) => {
        const productRef = db.collection('products').doc(product.id);

        return db.runTransaction(async (transaction) => {
          const productDoc = await transaction.get(productRef);

          if (!productDoc.exists) {
            throw new Error(`Producto ${product.id} no encontrado`);
          }

          const currentStock = productDoc.data().stock || 0;
          const newStock = currentStock - product.quantity;

          if (newStock < 0) {
            console.warn(`Stock negativo detectado para producto ${product.id}`);
          }

          transaction.update(productRef, {
            stock: newStock,
            lastSold: firestore.FieldValue.serverTimestamp()
          });
        });
      });

      await Promise.all(stockUpdates);

      console.log('Stock actualizado para todos los productos');

      // Enviar email al vendedor
      const productsList = order.products
        .map(p => `• ${p.name} - ${p.quantity} unidad(es)`)
        .join('\n');

      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: 'mati.iribarren98@gmail.com',
        subject: `Nueva venta - Orden ${externalReference}`,
        html: `
                <img src="https://firebasestorage.googleapis.com/v0/b/feg-dev.firebasestorage.app/o/logo.png?alt=media&token=071754cd-a5da-48c4-bb72-c016930c6fa8" alt="Logo" style="width: 100px; height: 100px;">
                <h1>¡Nueva venta realizada!</h1>
                <p>Detalles de la orden:</p>
                <ul>
                  <li>Fecha: ${new Date(order.date.seconds * 1000).toLocaleString('es-AR')}</li>
                  <li>Referencia: ${externalReference}</li>
                  <li>Total: $${order.total}</li>
                </ul>
                <h3>Productos vendidos:</h3>
                <ul>${order.products.map(p => `<li>${p.name} - ${p.quantity} unidad(es)</li>`).join('')}</ul>`
      };

      await transporter.sendMail(mailOptions);
      console.log('Notificación enviada al vendedor: mati.iribarren98@gmail.com');
    }

    return response.send('OK');

  } catch (error) {
    console.error('Error crítico en processOrder:', error);
    return response.status(500).send('Error interno del servidor');
  }
});

exports.processOrderByTransfer = onDocumentCreated('orders/{orderId}', async (event) => {
  try {
    const order = {
      id: event.id,
      ...event.data.data()
    };

    const db = firestore.getFirestore();

    // Verificar si es una orden por transferencia
    if (order.paymentMethod !== 'transferencia') {
      console.log('Orden no es por transferencia, ignorando:', order.id);
      return null;
    }

    console.log('Procesando nueva orden por transferencia:', order.id);

    // Generar tokens únicos para confirmar/rechazar
    const confirmToken = Math.random().toString(36).substring(2, 15);
    const rejectToken = Math.random().toString(36).substring(2, 15);

    // Guardar los tokens en la orden
    await db.collection('orders').doc(order.id).update({
      confirmToken,
      rejectToken,
      status: 'pending_confirmation',
      updatedAt: firestore.FieldValue.serverTimestamp()
    });

    // Crear URLs para los botones (reemplaza con tu dominio real)
    const confirmUrl = `https://confirmtransfer-pysmgizeyq-uc.a.run.app?orderId=${order.id}&token=${confirmToken}`;
    const rejectUrl = `https://rejecttransfer-pysmgizeyq-uc.a.run.app?orderId=${order.id}&token=${rejectToken}`;

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: 'mati.iribarren98@gmail.com',
      subject: `Confirmación de transferencia - Orden ${order.reference}`,
      html: `
          <img src="https://firebasestorage.googleapis.com/v0/b/feg-dev.firebasestorage.app/o/logo.png?alt=media&token=071754cd-a5da-48c4-bb72-c016930c6fa8" alt="Logo" style="width: 100px; height: 100px;">
          <h1>Nueva orden pendiente de confirmación</h1>
          <p>Por favor, confirma si has recibido la transferencia bancaria para la siguiente orden:</p>
          <div style="margin: 20px 0;">
            <h3>Detalles de la orden:</h3>
            <ul>
              <li>Referencia: ${order.reference}</li>
              <li>Total: $${order.total}</li>
              <li>Fecha: ${new Date(order.date.seconds * 1000).toLocaleString('es-AR')}</li>
            </ul>
            <h3>Productos:</h3>
            <ul>
              ${order.products.map(p => `<li>${p.name} - ${p.quantity} unidad(es)</li>`).join('')}
            </ul>
          </div>
          <div style="margin: 30px 0;">
            <a href="${confirmUrl}" style="background-color: #4CAF50; color: white; padding: 14px 25px; text-decoration: none; display: inline-block; margin-right: 10px;">
              Confirmar Transferencia
            </a>
            <a href="${rejectUrl}" style="background-color: #f44336; color: white; padding: 14px 25px; text-decoration: none; display: inline-block;">
              Rechazar Transferencia
            </a>
          </div>
          <p style="color: #666; font-size: 14px;">
            * Al confirmar la transferencia, la orden será procesada automáticamente.
          </p>
        `
    };

    await transporter.sendMail(mailOptions);
    console.log('Email de confirmación enviado al vendedor');

    return null;

  } catch (error) {
    console.error('Error en processOrderByTransfer:', error);
    return null;
  }
});

// Nuevas funciones para manejar la confirmación/rechazo
exports.confirmTransfer = onRequest(async (request, response) => {
  try {
    const { orderId, token } = request.query;
    const orderDoc = await firestore.collection('orders').doc(orderId).get();

    if (!orderDoc.exists || orderDoc.data().confirmToken !== token) {
      return response.status(400).send('Token inválido o orden no encontrada');
    }

    // Simular el body necesario para processOrder
    const simulatedBody = {
      external_reference: orderDoc.data().reference,
      status: 'approved'
    };

    // Llamar a processOrder
    const result = await processOrder({
      body: simulatedBody
    }, response);

    // Envia email al comprador
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: orderDoc.data().email,
      subject: `Confirmación de transferencia - Orden ${orderDoc.data().reference}`,
      html: `
        <img src="https://firebasestorage.googleapis.com/v0/b/feg-dev.firebasestorage.app/o/logo.png?alt=media&token=071754cd-a5da-48c4-bb72-c016930c6fa8" alt="Logo" style="width: 100px; height: 100px;">
        <h1>¡Transferencia confirmada!</h1>
        <p>La transferencia de la orden ${orderDoc.data().reference} ha sido confirmada.</p>
        <p>Detalles de la transferencia:</p>
        <ul>
          <li>Referencia: ${orderDoc.data().reference}</li>
          <li>Total: $${orderDoc.data().total}</li>
          <li>Fecha: ${new Date(orderDoc.data().date.seconds * 1000).toLocaleString('es-AR')}</li>
        </ul>
        <p>Gracias por tu compra.</p>
      `
    }

    await transporter.sendMail(mailOptions);
    console.log('Email de confirmación enviado al comprador');

    return result;

  } catch (error) {
    console.error('Error en confirmTransfer:', error);
    return response.status(500).send('Error interno del servidor');
  }
});

exports.rejectTransfer = onRequest(async (request, response) => {
  try {
    const { orderId, token } = request.query;
    const db = firestore.getFirestore();
    const orderDoc = await db.collection('orders').doc(orderId).get();

    if (!orderDoc.exists || orderDoc.data().rejectToken !== token) {
      return response.status(400).send('Token inválido o orden no encontrada');
    }

    // Actualizar el estado de la orden
    await db.collection('orders').doc(orderId).update({
      status: 'rejected',
      updatedAt: firestore.FieldValue.serverTimestamp()
    });

    // Envia email al comprador
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: orderDoc.data().email,
      subject: `Transferencia rechazada - Orden ${orderDoc.data().reference}`,
      html: `
        <img src="https://firebasestorage.googleapis.com/v0/b/feg-dev.firebasestorage.app/o/logo.png?alt=media&token=071754cd-a5da-48c4-bb72-c016930c6fa8" alt="Logo" style="width: 100px; height: 100px;">
        <h1>¡Transferencia rechazada!</h1>
        <p>La transferencia de la orden ${orderDoc.data().reference} ha sido rechazada.</p>
        <p>Detalles de la transferencia:</p>
        <ul>
          <li>Referencia: ${orderDoc.data().reference}</li>
          <li>Total: $${orderDoc.data().total}</li>
          <li>Fecha: ${new Date(orderDoc.data().date.seconds * 1000).toLocaleString('es-AR')}</li>
        </ul>
        <p>Por favor, envía un correo electrónico a <a href="mailto:mati.iribarren98@gmail.com">mati.iribarren98@gmail.com</a> para más información.</p>
      `
    }

    await transporter.sendMail(mailOptions);
    console.log('Email de rechazo enviado al comprador');

    return response.send('Orden rechazada exitosamente');

  } catch (error) {
    console.error('Error en rejectTransfer:', error);
    return response.status(500).send('Error interno del servidor');
  }
});