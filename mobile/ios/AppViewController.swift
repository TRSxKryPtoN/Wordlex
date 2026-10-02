// Registers the LocalRoom plugin with Capacitor (Capacitor 6 or newer).
// In Main.storyboard set the Bridge View Controller's class to AppViewController.

import Capacitor
import UIKit

class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(LocalRoomPlugin())
    }
}
