// Public API of the returns module. Nothing outside this folder may import from its other files (ADR 0005).
export {
  approveReturn,
  linkExchange,
  loadReturn,
  loadReturnItems,
  markReturnRefunded,
  receiveReturn,
  refundAmountFor,
  rejectReturn,
  requestReturn,
  RETURN_TRANSITIONS,
  transitionReturn,
} from './service';
export { applyReturnEvent, getReturn, projectReturn, renderReturn } from './read-model';
export type { ProjectedEvent, ReturnProjection } from './read-model';
// Refund seam: window 7 registers its requester at boot (writes the refund row + refund.* events, returns the id).
export {
  currentRefundRequester,
  manualRefundRequester,
  refundKeyFor,
  setRefundRequester,
} from './refund-seam';
export type {
  AdminReturn,
  ReceivedItem,
  ReceiveReturnInput,
  RefundRequest,
  RefundRequester,
  RefundResponse,
  RequestedItem,
  RequestReturnInput,
  ReturnCondition,
  ReturnItemRow,
  ReturnRow,
  ReturnStatus,
} from './types';
