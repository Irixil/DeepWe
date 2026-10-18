import LegacyCouplePage from "../LegacyCouplePage";
import PrivateAccountBoundary from "../PrivateAccountBoundary";

export default function CouplePage() {
  return <PrivateAccountBoundary><LegacyCouplePage /></PrivateAccountBoundary>;
}
