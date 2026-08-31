type JsonObject = Record<string, unknown>;

export function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function string(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function boolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function orderFacts(detail: JsonObject, itemLimit: number): JsonObject {
  const items = array(detail.items).slice(0, itemLimit).map((raw) => {
    const item = object(raw);
    return {
      sku: string(item.sku),
      name: string(item.name),
      quantity: number(item.qty),
      unit_price: number(item.unitPrice),
      gift: boolean(item.isGift),
    };
  });
  const missing = [
    ['status', detail.status],
    ['payment_status', detail.paymentStatus],
    ['currency', detail.currency],
    ['total_gross', detail.totalGross],
  ]
    .filter(([, value]) => value == null || value === '')
    .map(([field]) => field);

  return {
    order_number: string(detail.orderNumber),
    external_id: string(detail.externalOrderId),
    source_code: string(detail.sourceCode),
    status: string(detail.status),
    payment_status: string(detail.paymentStatus),
    payment_method: string(detail.paymentMethod),
    currency: string(detail.currency),
    total_gross: string(detail.totalGross),
    cod: boolean(detail.cod),
    priority: number(detail.priority),
    flags: array(detail.flags).filter((value): value is string => typeof value === 'string'),
    special_queue: string(detail.specialQueue),
    total_items: number(detail.totalItems),
    items,
    items_truncated: array(detail.items).length > itemLimit,
    missing_fields: missing,
  };
}

export function paymentFacts(detail: JsonObject): JsonObject {
  const returns = array(detail.returns).map(object);
  const corrections = array(detail.erpCorrections).map(object);
  return {
    order_number: string(detail.orderNumber),
    status: string(detail.paymentStatus),
    method: string(detail.paymentMethod),
    currency: string(detail.currency),
    amount: string(detail.totalGross),
    cod: boolean(detail.cod),
    source_payment_refunded: boolean(detail.sourcePaymentRefunded),
    source_payment_failed: boolean(detail.sourcePaymentFailed),
    last_payment_link_sms_sent_at: string(detail.lastPaymentLinkSmsSentAt),
    refunds: returns.map((ret) => ({
      return_id: string(ret.id),
      type: string(ret.type),
      refund_status: string(ret.refundStatus),
      status: string(ret.status),
      correction_reference: string(ret.corrRef),
      created_at: string(ret.createdAt),
    })),
    erp_corrections: corrections.map((correction) => ({
      kind: string(correction.kind),
      status: string(correction.status),
      correction_reference: string(correction.corrRef),
      reason_code: string(correction.reason),
      created_at: string(correction.createdAt),
      updated_at: string(correction.updatedAt),
    })),
    missing_fields: detail.paymentStatus == null ? ['payment_status'] : [],
  };
}

export function fulfillmentFacts(detail: JsonObject): JsonObject {
  const block = object(detail.blockReason);
  return {
    order_number: string(detail.orderNumber),
    order_status: string(detail.status),
    blocked: Object.keys(block).length > 0,
    block_reason_code: string(block.code),
    special_queue: string(detail.specialQueue),
    erp_order_reference: string(detail.erpOrderRef),
    erp_document_number: string(detail.erpOrderDocNumber),
    wz_number: string(detail.wzNumber),
    invoice_number: string(detail.fvNumber),
    picking_started_at: string(detail.pickingStartedAt),
    picking_batch_code: string(detail.pickingBatchCode),
    label_printed_at: string(detail.labelPrintedAt),
    loose_label: boolean(detail.luznaEtykieta),
    personal_pickup: boolean(detail.odbiorOsobisty),
    resends: array(detail.resends).map((raw) => {
      const resend = object(raw);
      return {
        order_number: string(resend.orderNumber),
        status: string(resend.status),
        tracking_number: string(resend.trackingNumber),
        kind: string(resend.kind),
      };
    }),
  };
}

/**
 * Dane dostawy potrzebne BOK do odpowiedzi na aktywną sprawę klienta. Celowo nie zwracamy
 * nazwiska, e-maila ani telefonu, ale zachowujemy dokładny adres i punkt odbioru — bez nich
 * agent nie może sprawdzić, czy klient podał właściwe miejsce doręczenia.
 */
export function deliveryFacts(detail: JsonObject): JsonObject {
  const address = object(detail.shippingAddress);
  const pickupPointId = string(detail.pickupPointId) ?? string(address.pickupPointId);
  const pickupPointName = string(detail.pickupPointName);
  const personalPickup = boolean(detail.odbiorOsobisty);
  const validation = object(detail.addressValidation);
  return {
    order_number: string(detail.orderNumber),
    delivery_type: personalPickup === true
      ? 'personal_pickup'
      : pickupPointId || pickupPointName
        ? 'pickup_point'
        : 'address',
    carrier_code: string(detail.carrierCode),
    personal_pickup: personalPickup,
    pickup_point: pickupPointId || pickupPointName
      ? {
          id: pickupPointId,
          name_and_address: pickupPointName,
        }
      : null,
    shipping_address: Object.keys(address).length
      ? {
          line1: string(address.line1),
          line2: string(address.line2),
          city: string(address.city),
          postal_code: string(address.postalCode),
          country_code: string(address.countryCode),
        }
      : null,
    address_validation: Object.keys(validation).length
      ? {
          status: string(validation.status),
          issues: array(validation.issues).slice(0, 20).map((raw) => {
            const issue = object(raw);
            return {
              field: string(issue.field),
              severity: string(issue.severity),
              message: string(issue.message),
              suggestion: string(issue.suggestion),
            };
          }),
        }
      : null,
    missing_fields: [
      ...(!pickupPointId && !pickupPointName && Object.keys(address).length === 0
        ? ['delivery_destination']
        : []),
    ],
  };
}

export function shipmentFacts(detail: JsonObject, eventsByShipment: Map<string, unknown[]> = new Map()): JsonObject {
  const shipments = array(detail.shipments).map((raw) => {
    const shipment = object(raw);
    const id = string(shipment.id);
    return {
      shipment_id: id,
      carrier_code: string(shipment.carrierCode),
      final_carrier_code: string(shipment.przewoznikDocelowy),
      external_id: string(shipment.externalId),
      tracking_number: string(shipment.trackingNumber),
      tracking_url: string(shipment.trackingUrl),
      status: string(shipment.status),
      canonical: boolean(shipment.canonical),
      invalidated_at: string(shipment.invalidatedAt),
      created_at: string(shipment.createdAt),
      scans: (id ? (eventsByShipment.get(id) ?? []) : []).map((eventRaw) => {
        const event = object(eventRaw);
        return {
          status: string(event.status),
          description: string(event.description),
          occurred_at: string(event.occurredAt),
          source: string(event.source),
          recorded_at: string(event.createdAt),
        };
      }),
    };
  });
  return {
    order_number: string(detail.orderNumber),
    current_tracking_number: string(detail.trackingNumber),
    current_shipment_status: string(detail.shipmentStatus),
    shipments,
    missing_fields: shipments.length === 0 ? ['shipments'] : [],
  };
}

export function returnsFacts(detail: JsonObject): JsonObject {
  const returns = array(detail.returns).map((raw) => {
    const ret = object(raw);
    const correction = object(ret.correction);
    return {
      return_id: string(ret.id),
      type: string(ret.type),
      items: array(ret.items).map((itemRaw) => {
        const item = object(itemRaw);
        return {
          sku: string(item.sku),
          quantity: number(item.qty),
          unfit_quantity: number(item.unfitQty),
        };
      }),
      reason_code: string(ret.reason),
      reason_note_present: string(ret.reasonNote) != null,
      refund_status: string(ret.refundStatus),
      status: string(ret.status),
      correction_reference: string(ret.corrRef),
      correction: Object.keys(correction).length
        ? {
            status: string(correction.status),
            reference: string(correction.corrRef),
            kind: string(correction.kind),
          }
        : null,
      created_at: string(ret.createdAt),
    };
  });
  return {
    order_number: string(detail.orderNumber),
    returns,
    return_count: returns.length,
    missing_fields: [],
  };
}

export function orderTimestamps(detail: JsonObject): JsonObject {
  return {
    placed_at: string(detail.placedAt),
    imported_at: string(detail.createdAt),
    updated_at: string(detail.updatedAt),
    current_status_since: string(detail.statusOd),
    status_history: array(detail.statusHistory).map((raw) => {
      const history = object(raw);
      return {
        from: string(history.fromStatus),
        to: string(history.toStatus),
        changed_at: string(history.createdAt),
        reason_present: string(history.reason) != null,
      };
    }),
  };
}

export function safeBeforeAfter(detail: JsonObject): JsonObject {
  return {
    order_number: string(detail.orderNumber),
    status: string(detail.status),
    payment_status: string(detail.paymentStatus),
    carrier_code: string(detail.carrierCode),
    pickup_point_present: string(detail.pickupPointId) != null,
    shipping_address_present: Object.keys(object(detail.shippingAddress)).length > 0,
    return_count: array(detail.returns).length,
    internal_note_count: array(detail.internalNotes).length,
    updated_at: string(detail.updatedAt),
  };
}
