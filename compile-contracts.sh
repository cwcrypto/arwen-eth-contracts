#!/bin/bash
cd $(dirname $0)  # set cwd so this script can be called from another dir

OUTPUT_DIR="build/solc-contracts-bin"
SOLC_VERSION="solc:0.5.12"

rm -rf ${OUTPUT_DIR}
mkdir -p $OUTPUT_DIR

# ensure all npm module dependencies are up-to-date open-zeppelin dependency
echo "Updating openzeppelin-solidity dependencies"
npm install

# print version of openzepplin-solidity being used
echo "openzeppelin-solidity version:"
npm ls openzeppelin-solidity

# Check solc is available
command -v docker >/dev/null 2>&1
if [ $? != 0 ]; then
    echo "You need to install docker!"
    echo "https://hub.docker.com/"
    exit 1
else
    # print docker version
    docker --version
fi

# Check if correct docker image is downloaded
docker run ethereum/${SOLC_VERSION} --version

# Compile solditiy source code using solc docker
declare -a CONTRACTS=(
    "EscrowFactoryWithERC20.sol"
    "EscrowFactory.sol"
    "Escrow.sol"
    "TestToken.sol"
)

MOUNT_DIR="/sources"
FULL_PATH_CONTRACTS=""
for CONTRACT in "${CONTRACTS[@]}"
do
    FULL_PATH_CONTRACTS+=" $MOUNT_DIR/contracts/$CONTRACT"
done

echo "Compiling ${CONTRACTS} and writing abi/bin files to ${OUTPUT_DIR}"
docker run -v $(pwd):$MOUNT_DIR ethereum/$SOLC_VERSION "openzeppelin-solidity/=$MOUNT_DIR/node_modules/openzeppelin-solidity/" --abi --bin --overwrite $FULL_PATH_CONTRACTS -o $MOUNT_DIR/$OUTPUT_DIR

# output .bytecode file with correct format for truffle to be able to build json artifacts
# adds quotes and 0x prefix to the bytecode
sed -e 's/\(.*\)/\"0x\1\"/g' ${OUTPUT_DIR}/EthEscrow.bin > ${OUTPUT_DIR}/EthEscrow.bytecode
sed -e 's/\(.*\)/\"0x\1\"/g' ${OUTPUT_DIR}/Erc20Escrow.bin > ${OUTPUT_DIR}/Erc20Escrow.bytecode