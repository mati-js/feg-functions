const {onRequest} = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const serviceAccount = require("./gcloud/serviceAccount.json");
const firestore = require("firebase-admin/firestore");

admin.initializeApp(serviceAccount);


// Create a cloud function onRequest that emails both buyer and seller about an order id
const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

exports.processOrder = onRequest(async (request, response) => {
  try {
    console.log('Iniciando procesamiento de orden:', request.body);

    if (!request.body || !request.body.external_reference) {
      console.error('Solicitud inválida:', request.body);
      return response.status(400).send({ error: 'Solicitud inválida.' });
    }

    const externalReference = request.body.external_reference;
    const db = firestore;

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
    await orderDoc.ref.update({
      paymentInformation: request.body,
      updatedAt: firestore.FieldValue.serverTimestamp()
    });

    if (request.body.status === 'approved') {
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
      if (order.sellerEmail) {
        const productsList = order.products
          .map(p => `• ${p.name} - ${p.quantity} unidad(es)`)
          .join('\n');

        const msg = {
          to: order.sellerEmail,
          from: process.env.SENDER_EMAIL,
          subject: `Nueva venta - Orden ${externalReference}`,
          text: `¡Has realizado una nueva venta!\n\n
                 Detalles de la orden:\n
                 Referencia: ${externalReference}\n
                 Productos vendidos:\n${productsList}\n\n
                 Total: $${order.total}\n
                 Fecha: ${new Date().toLocaleString()}`,
          html: `<h1>¡Nueva venta realizada!</h1>
                <p>Detalles de la orden:</p>
                <ul>
                  <li>Referencia: ${externalReference}</li>
                  <li>Total: $${order.total}</li>
                  <li>Fecha: ${new Date().toLocaleString()}</li>
                </ul>
                <h3>Productos vendidos:</h3>
                <ul>${order.products.map(p => `<li>${p.name} - ${p.quantity} unidad(es)</li>`).join('')}</ul>`
        };

        await sgMail.send(msg);
        console.log('Notificación enviada al vendedor:', order.sellerEmail);
      }
    }

    return response.send('OK');
    
  } catch (error) {
    console.error('Error crítico en processOrder:', error);
    return response.status(500).send('Error interno del servidor');
  }
});

// Trigger en collección de ordenes cuando se crea un documento
exports.processOrderByTransfer;